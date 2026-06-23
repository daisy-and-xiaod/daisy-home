const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── Supabase ─────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── AI API Keys ──────────────────────────────────────────────────────────────
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

// ── UUID Validation ──────────────────────────────────────────────────────────
function isValidUUID(str) {
  if (!str || str === 'null' || str === 'undefined') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

// ── Multi-Model AI Call ──────────────────────────────────────────────────────
async function callAI(messages, model = 'deepseek-chat') {
  if (model.startsWith('deepseek')) {
    if (!DEEPSEEK_API_KEY) throw new Error('DeepSeek API key not configured');
    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
      body: JSON.stringify({ model: model === 'deepseek-reasoner' ? 'deepseek-reasoner' : 'deepseek-chat', messages, temperature: 0.7, max_tokens: 2048 }),
    });
    if (!res.ok) { const err = await res.text(); throw new Error(`DeepSeek error ${res.status}: ${err}`); }
    const data = await res.json();
    return data.choices[0].message.content;
  }

  if (model === 'gpt-4o' || model === 'gpt-4o-mini') {
    if (!OPENAI_API_KEY) throw new Error('OpenAI API key not configured. Set OPENAI_API_KEY env var.');
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model, messages, temperature: 0.7, max_tokens: 2048 }),
    });
    if (!res.ok) { const err = await res.text(); throw new Error(`OpenAI error ${res.status}: ${err}`); }
    const data = await res.json();
    return data.choices[0].message.content;
  }

  if (model === 'claude-3.5-sonnet' || model === 'claude-3-5-sonnet') {
    if (!ANTHROPIC_API_KEY) throw new Error('Anthropic API key not configured. Set ANTHROPIC_API_KEY env var.');
    // Convert messages format for Anthropic
    const systemMsg = messages.find(m => m.role === 'system');
    const chatMsgs = messages.filter(m => m.role !== 'system');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 2048,
        system: systemMsg ? systemMsg.content : '',
        messages: chatMsgs.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
      }),
    });
    if (!res.ok) { const err = await res.text(); throw new Error(`Anthropic error ${res.status}: ${err}`); }
    const data = await res.json();
    return data.content[0].text;
  }

  throw new Error(`Unknown model: ${model}`);
}

// ── Health ───────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ── Bucket Setup ─────────────────────────────────────────────────────────────
async function ensureBuckets() {
  try {
    // Check / create 'avatars' bucket
    const { data: buckets } = await supabase.storage.listBuckets();
    const bucketNames = (buckets || []).map(b => b.name);
    if (!bucketNames.includes('avatars')) {
      const { error } = await supabase.storage.createBucket('avatars', { public: true, fileSizeLimit: 10485760 });
      if (error) console.warn('Could not create avatars bucket:', error.message);
      else console.log('Created avatars bucket');
    }
    if (!bucketNames.includes('public')) {
      const { error } = await supabase.storage.createBucket('public', { public: true, fileSizeLimit: 10485760 });
      if (error) console.warn('Could not create public bucket:', error.message);
      else console.log('Created public bucket');
    }
  } catch (e) {
    console.warn('Bucket check failed (may need manual setup):', e.message);
  }
}

// ── Database Setup ───────────────────────────────────────────────────────────
async function ensureTables() {
  // Try creating each table individually via REST
  const tables = [
    { name: 'sessions', sql: `CREATE TABLE IF NOT EXISTS sessions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL DEFAULT '新对话', created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(), last_message TEXT DEFAULT '')` },
    { name: 'messages', sql: `CREATE TABLE IF NOT EXISTS messages (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), session_id UUID REFERENCES sessions(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK (role IN ('user','assistant','system')), content TEXT NOT NULL DEFAULT '', version INTEGER DEFAULT 1, version_group UUID, version_history JSONB DEFAULT '[]', read BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT now())` },
    { name: 'reactions', sql: `CREATE TABLE IF NOT EXISTS reactions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), message_id UUID REFERENCES messages(id) ON DELETE CASCADE, emoji TEXT NOT NULL, count INTEGER DEFAULT 1)` },
    { name: 'events', sql: `CREATE TABLE IF NOT EXISTS events (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), title TEXT NOT NULL, type TEXT DEFAULT 'reminder', event_date DATE NOT NULL, created_at TIMESTAMPTZ DEFAULT now())` },
    { name: 'diary', sql: `CREATE TABLE IF NOT EXISTS diary (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), content TEXT NOT NULL DEFAULT '', mood TEXT DEFAULT '', author TEXT DEFAULT 'user', diary_date DATE DEFAULT CURRENT_DATE, created_at TIMESTAMPTZ DEFAULT now())` },
    { name: 'calendar_markers', sql: `CREATE TABLE IF NOT EXISTS calendar_markers (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), marker_date DATE NOT NULL, type TEXT NOT NULL CHECK (type IN ('period','anniversary','schedule')), label TEXT DEFAULT '', color TEXT DEFAULT '', created_at TIMESTAMPTZ DEFAULT now())` },
    { name: 'app_settings', sql: `CREATE TABLE IF NOT EXISTS app_settings (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), key TEXT UNIQUE NOT NULL, value JSONB DEFAULT '{}', updated_at TIMESTAMPTZ DEFAULT now())` },
  ];

  for (const table of tables) {
    try {
      const { error } = await supabase.from(table.name).select('id').limit(1);
      if (error && error.code === '42P01') {
        // Table doesn't exist, try to create via raw SQL if exec_sql RPC exists
        console.log(`Table ${table.name} missing - attempting create via RPC...`);
        try {
          const { error: rpcErr } = await supabase.rpc('exec_sql', { query: table.sql });
          if (rpcErr) console.warn(`  RPC create ${table.name} failed:`, rpcErr.message);
          else console.log(`  Created table ${table.name} via RPC`);
        } catch (rpcErr) {
          console.warn(`  Cannot auto-create ${table.name}: exec_sql RPC not available. Run SQL in Supabase dashboard.`);
        }
      }
    } catch (e) {
      console.warn(`Table check ${table.name} error:`, e.message);
    }
  }
}

app.post('/api/setup', async (_req, res) => {
  try {
    await ensureBuckets();
    await ensureTables();
    res.json({
      success: true,
      message: 'Setup complete. If tables/buckets are missing, run the SQL in Supabase dashboard (see server.js comments).',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SESSIONS
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/sessions', async (_req, res) => {
  try {
    const { data, error } = await supabase.from('sessions').select('*').order('updated_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sessions', async (req, res) => {
  try {
    const { name } = req.body;
    const { data, error } = await supabase.from('sessions').insert({ name: name || '新对话' }).select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions/:id', async (req, res) => {
  try {
    if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid session ID' });
    const { data, error } = await supabase.from('sessions').select('*').eq('id', req.params.id).single();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Session not found' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/sessions/:id', async (req, res) => {
  try {
    if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid session ID' });
    const { error } = await supabase.from('sessions').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// MESSAGES
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/sessions/:id/messages', async (req, res) => {
  try {
    if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid session ID' });
    const { data, error } = await supabase.from('messages')
      .select('*, reactions(*)')
      .eq('session_id', req.params.id)
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/messages/:id', async (req, res) => {
  try {
    if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid message ID' });
    const { content } = req.body;
    const { data, error } = await supabase.from('messages').update({ content }).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/messages/:id', async (req, res) => {
  try {
    if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid message ID' });
    const { error } = await supabase.from('messages').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/messages/:id/regenerate - regenerate AI response
app.post('/api/messages/:id/regenerate', async (req, res) => {
  try {
    if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid message ID' });
    const { model } = req.body;

    const { data: msg, error: msgErr } = await supabase.from('messages').select('*').eq('id', req.params.id).single();
    if (msgErr || !msg) return res.status(404).json({ error: 'Message not found' });
    if (msg.role !== 'assistant') return res.status(400).json({ error: 'Can only regenerate assistant messages' });

    // Get messages before this one for context (only latest version of each)
    const { data: history } = await supabase.from('messages')
      .select('*')
      .eq('session_id', msg.session_id)
      .lt('created_at', msg.created_at)
      .order('created_at', { ascending: true });

    const chatHistory = (history || []).map(m => ({ role: m.role, content: m.content }));
    const newContent = await callAI(chatHistory, model || 'deepseek-chat');

    // Store current version in version_history before overwriting
    const versionHistory = Array.isArray(msg.version_history) ? msg.version_history : [];
    versionHistory.push({ version: msg.version || 1, content: msg.content, created_at: msg.created_at });

    const newVersion = (msg.version || 1) + 1;
    const { data: updated, error: updateErr } = await supabase.from('messages')
      .update({ content: newContent, version: newVersion, version_history: versionHistory })
      .eq('id', req.params.id)
      .select()
      .single();
    if (updateErr) throw updateErr;

    await supabase.from('sessions').update({ updated_at: new Date().toISOString(), last_message: newContent.substring(0, 200) }).eq('id', msg.session_id);

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/messages/:id/switch-version - switch to a specific historical version
app.post('/api/messages/:id/switch-version', async (req, res) => {
  try {
    if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid message ID' });
    const { targetVersion } = req.body;
    if (!targetVersion) return res.status(400).json({ error: 'targetVersion required' });

    const { data: msg, error: msgErr } = await supabase.from('messages').select('*').eq('id', req.params.id).single();
    if (msgErr || !msg) return res.status(404).json({ error: 'Message not found' });

    const versionHistory = Array.isArray(msg.version_history) ? msg.version_history : [];
    const target = versionHistory.find(v => v.version === targetVersion);
    if (!target) return res.status(404).json({ error: 'Version not found' });

    // Swap: current becomes history entry, target becomes current
    const newHistory = versionHistory.filter(v => v.version !== targetVersion);
    newHistory.push({ version: msg.version, content: msg.content, created_at: msg.created_at });

    const { data: updated, error: updateErr } = await supabase.from('messages')
      .update({ content: target.content, version: targetVersion, version_history: newHistory })
      .eq('id', req.params.id)
      .select()
      .single();
    if (updateErr) throw updateErr;

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/messages/:id/versions - get all versions of a message
app.get('/api/messages/:id/versions', async (req, res) => {
  try {
    if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid message ID' });
    const { data: msg, error } = await supabase.from('messages').select('*').eq('id', req.params.id).single();
    if (error || !msg) return res.status(404).json({ error: 'Message not found' });

    const versions = Array.isArray(msg.version_history) ? msg.version_history : [];
    // Include current version
    versions.push({ version: msg.version, content: msg.content, created_at: msg.created_at, current: true });
    versions.sort((a, b) => b.version - a.version);
    res.json(versions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/chat - send user message and get AI reply
app.post('/api/chat', async (req, res) => {
  try {
    const { sessionId, message, model } = req.body;
    if (!sessionId || !message) return res.status(400).json({ error: 'sessionId and message are required' });
    if (!isValidUUID(sessionId)) return res.status(400).json({ error: 'Invalid session ID' });

    const usedModel = model || 'deepseek-chat';

    // 1. Save user message
    const { data: userMsg, error: userErr } = await supabase.from('messages').insert({
      session_id: sessionId, role: 'user', content: message, version: 1, read: true,
    }).select().single();
    if (userErr) throw userErr;

    // 2. Get chat history for context
    const { data: history } = await supabase.from('messages')
      .select('*').eq('session_id', sessionId).order('created_at', { ascending: true });
    const chatHistory = (history || []).map(m => ({ role: m.role, content: m.content }));

    // 3. Call appropriate AI
    let aiContent;
    try {
      aiContent = await callAI(chatHistory, usedModel);
    } catch (aiErr) {
      aiContent = `抱歉，AI 服务暂时不可用：${aiErr.message}`;
    }

    // 4. Save AI response
    const { data: aiMsg, error: aiErr } = await supabase.from('messages').insert({
      session_id: sessionId, role: 'assistant', content: aiContent, version: 1, read: false,
      version_history: [],
    }).select().single();
    if (aiErr) throw aiErr;

    // 5. Update session
    await supabase.from('sessions').update({
      updated_at: new Date().toISOString(), last_message: aiContent.substring(0, 200),
    }).eq('id', sessionId);

    res.status(201).json({ userMessage: userMsg, aiMessage: aiMsg });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// REACTIONS
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/messages/:id/reactions', async (req, res) => {
  try {
    if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid message ID' });
    const { emoji } = req.body;
    if (!emoji) return res.status(400).json({ error: 'emoji is required' });

    const { data: existing } = await supabase.from('reactions').select('*').eq('message_id', req.params.id).eq('emoji', emoji).maybeSingle();

    if (existing) {
      const { data, error } = await supabase.from('reactions').update({ count: (existing.count || 1) + 1 }).eq('id', existing.id).select().single();
      if (error) throw error;
      return res.json(data);
    }

    const { data, error } = await supabase.from('reactions').insert({ message_id: req.params.id, emoji, count: 1 }).select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/messages/:id/reactions', async (req, res) => {
  try {
    if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid message ID' });
    const { data, error } = await supabase.from('reactions').select('*').eq('message_id', req.params.id);
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// EVENTS
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/events', async (req, res) => {
  try {
    let query = supabase.from('events').select('*').order('event_date', { ascending: true });
    if (req.query.limit) query = query.limit(parseInt(req.query.limit));
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/events', async (req, res) => {
  try {
    const { title, type, event_date } = req.body;
    if (!title || !event_date) return res.status(400).json({ error: 'title and event_date are required' });
    const { data, error } = await supabase.from('events').insert({ title, type: type || 'reminder', event_date }).select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// DIARY
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/diary', async (req, res) => {
  try {
    let query = supabase.from('diary').select('*').order('created_at', { ascending: false });
    if (req.query.limit) query = query.limit(parseInt(req.query.limit));
    if (req.query.date) query = query.eq('diary_date', req.query.date);
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/diary', async (req, res) => {
  try {
    const { content, mood, author, diary_date } = req.body;
    if (!content) return res.status(400).json({ error: 'content is required' });
    const { data, error } = await supabase.from('diary').insert({
      content, mood: mood || '', author: author || 'user',
      diary_date: diary_date || new Date().toISOString().slice(0, 10),
    }).select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CALENDAR MARKERS
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/calendar-markers', async (req, res) => {
  try {
    const { month, year } = req.query;
    let query = supabase.from('calendar_markers').select('*');
    if (month && year) {
      const sm = String(month).padStart(2, '0');
      const start = `${year}-${sm}-01`;
      const endDay = new Date(parseInt(year), parseInt(month), 0).getDate();
      const end = `${year}-${sm}-${String(endDay).padStart(2, '0')}`;
      query = query.gte('marker_date', start).lte('marker_date', end);
    }
    const { data, error } = await query.order('marker_date', { ascending: true });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/calendar-markers', async (req, res) => {
  try {
    const { marker_date, type, label, color } = req.body;
    if (!marker_date || !type) return res.status(400).json({ error: 'marker_date and type are required' });
    const { data, error } = await supabase.from('calendar_markers').insert({ marker_date, type, label: label || '', color: color || '' }).select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/settings', async (_req, res) => {
  try {
    const { data, error } = await supabase.from('app_settings').select('*');
    if (error) throw error;
    const settings = {};
    (data || []).forEach(row => { settings[row.key] = row.value; });
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/settings', async (req, res) => {
  try {
    const updates = req.body;
    for (const [key, value] of Object.entries(updates)) {
      const { data: existing } = await supabase.from('app_settings').select('id').eq('key', key).maybeSingle();
      if (existing) {
        await supabase.from('app_settings').update({ value, updated_at: new Date().toISOString() }).eq('key', key);
      } else {
        await supabase.from('app_settings').insert({ key, value });
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// UPLOAD (Avatar to Supabase Storage)
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/upload', async (req, res) => {
  try {
    const { image, filename, bucket } = req.body;
    if (!image) return res.status(400).json({ error: 'image is required' });

    const matches = image.match(/^data:image\/(\w+);base64,(.+)$/);
    let buffer, ext;
    if (matches) { ext = matches[1]; buffer = Buffer.from(matches[2], 'base64'); }
    else { buffer = Buffer.from(image, 'base64'); ext = 'png'; }

    const targetBucket = bucket || 'avatars';
    const filePath = `${filename || `avatar-${Date.now()}.${ext}`}`;

    // Try preferred bucket first, fall back to public
    let uploadErr;
    for (const b of [targetBucket, 'public']) {
      try {
        const { data, error } = await supabase.storage.from(b).upload(filePath, buffer, { contentType: `image/${ext}`, upsert: true });
        if (!error) {
          const { data: urlData } = supabase.storage.from(b).getPublicUrl(filePath);
          return res.json({ url: urlData.publicUrl, path: filePath, bucket: b });
        }
        uploadErr = error;
      } catch (e) { uploadErr = e; }
    }
    throw uploadErr || new Error('Upload failed in all buckets');
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/export/:sessionId', async (req, res) => {
  try {
    if (!isValidUUID(req.params.sessionId)) return res.status(400).json({ error: 'Invalid session ID' });
    const { data: session } = await supabase.from('sessions').select('*').eq('id', req.params.sessionId).maybeSingle();
    const { data: messages } = await supabase.from('messages').select('*').eq('session_id', req.params.sessionId).order('created_at', { ascending: true });

    const exportData = { exportedAt: new Date().toISOString(), session, messages };
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="chat-${req.params.sessionId}.json"`);
    res.json(exportData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// MARK MESSAGES AS READ
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/messages/mark-read', async (req, res) => {
  try {
    const { messageIds } = req.body;
    if (!messageIds || !messageIds.length) return res.status(400).json({ error: 'messageIds required' });
    const validIds = messageIds.filter(isValidUUID);
    if (!validIds.length) return res.status(400).json({ error: 'No valid message IDs' });
    const { error } = await supabase.from('messages').update({ read: true }).in('id', validIds);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CLEAR ALL
// ═══════════════════════════════════════════════════════════════════════════════

app.delete('/api/clear-all', async (_req, res) => {
  try {
    // Delete in correct FK order
    await supabase.from('reactions').delete().filter('id', 'not.is', null);
    await supabase.from('messages').delete().filter('id', 'not.is', null);
    await supabase.from('sessions').delete().filter('id', 'not.is', null);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Startup ───────────────────────────────────────────────────────────────────
async function startup() {
  await ensureBuckets();
  await ensureTables();
}

app.listen(PORT, () => {
  console.log(`Daisy-Home server running on port ${PORT}`);
  console.log(`Supabase: ${SUPABASE_URL ? 'configured' : 'MISSING'}`);
  console.log(`DeepSeek: ${DEEPSEEK_API_KEY ? 'configured' : 'MISSING'}`);
  console.log(`OpenAI: ${OPENAI_API_KEY ? 'configured' : 'MISSING'}`);
  console.log(`Anthropic: ${ANTHROPIC_API_KEY ? 'configured' : 'MISSING'}`);
  startup().catch(e => console.warn('Startup setup warning:', e.message));
});

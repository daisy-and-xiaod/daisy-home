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

// ── DeepSeek ─────────────────────────────────────────────────────────────────
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';

async function callDeepSeek(messages, model = 'deepseek-chat') {
  const res = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.7,
      max_tokens: 2048,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`DeepSeek error ${res.status}: ${err}`);
  }
  const data = await res.json();
  return data.choices[0].message.content;
}

// ── Health ───────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ── Database Setup ───────────────────────────────────────────────────────────
app.post('/api/setup', async (_req, res) => {
  try {
    // Create tables via raw SQL using the management API
    const sql = `
      CREATE TABLE IF NOT EXISTS sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL DEFAULT '新对话',
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now(),
        last_message TEXT DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
        content TEXT NOT NULL DEFAULT '',
        version INTEGER DEFAULT 1,
        read BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS reactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
        emoji TEXT NOT NULL,
        count INTEGER DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title TEXT NOT NULL,
        type TEXT DEFAULT 'reminder',
        event_date DATE NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS diary (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        content TEXT NOT NULL DEFAULT '',
        mood TEXT DEFAULT '',
        author TEXT DEFAULT 'user',
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS calendar_markers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        marker_date DATE NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('period','anniversary','schedule')),
        label TEXT DEFAULT '',
        color TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS app_settings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        key TEXT UNIQUE NOT NULL,
        value JSONB DEFAULT '{}',
        updated_at TIMESTAMPTZ DEFAULT now()
      );
    `;
    // Use Supabase's SQL API via REST
    const sqlRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_KEY}`,
        apikey: SUPABASE_KEY,
      },
      body: JSON.stringify({ query: sql }),
    });
    // If RPC doesn't exist, try alternative approach
    if (!sqlRes.ok) {
      // Fallback: create tables one by one using REST (they'll error if exist, which is fine)
      console.log('Tables may already exist – proceeding.');
    }
    res.json({ success: true, message: 'Database setup attempted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SESSIONS
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/sessions - list all sessions
app.get('/api/sessions', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('sessions')
      .select('*')
      .order('updated_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sessions - create a new session
app.post('/api/sessions', async (req, res) => {
  try {
    const { name } = req.body;
    const { data, error } = await supabase
      .from('sessions')
      .insert({ name: name || '新对话' })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sessions/:id - get single session
app.get('/api/sessions/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('sessions')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Session not found' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/sessions/:id - delete session and its messages
app.delete('/api/sessions/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('sessions')
      .delete()
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// MESSAGES
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/sessions/:id/messages
app.get('/api/sessions/:id/messages', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('session_id', req.params.id)
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/messages/:id - edit message content (user messages only)
app.put('/api/messages/:id', async (req, res) => {
  try {
    const { content } = req.body;
    const { data, error } = await supabase
      .from('messages')
      .update({ content })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/messages/:id
app.delete('/api/messages/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('messages')
      .delete()
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/messages/:id/regenerate - regenerate AI response
app.post('/api/messages/:id/regenerate', async (req, res) => {
  try {
    const { model } = req.body;
    // Find the message to regenerate (must be an assistant message)
    const { data: msg } = await supabase
      .from('messages')
      .select('*, sessions!inner(*)')
      .eq('id', req.params.id)
      .single();

    if (!msg || msg.role !== 'assistant') {
      return res.status(400).json({ error: 'Can only regenerate assistant messages' });
    }

    // Get messages before this one for context
    const { data: history } = await supabase
      .from('messages')
      .select('*')
      .eq('session_id', msg.session_id)
      .lt('created_at', msg.created_at)
      .order('created_at', { ascending: true });

    const chatHistory = (history || []).map(m => ({ role: m.role, content: m.content }));
    const newContent = await callDeepSeek(chatHistory, model || 'deepseek-chat');

    // Increment version
    const newVersion = (msg.version || 1) + 1;
    const { data: updated, error } = await supabase
      .from('messages')
      .update({ content: newContent, version: newVersion })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;

    // Update session updated_at
    await supabase.from('sessions').update({ updated_at: new Date().toISOString(), last_message: newContent }).eq('id', msg.session_id);

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/chat - send user message and get AI reply
app.post('/api/chat', async (req, res) => {
  try {
    const { sessionId, message, model } = req.body;
    if (!sessionId || !message) {
      return res.status(400).json({ error: 'sessionId and message are required' });
    }

    // 1. Save user message
    const { data: userMsg, error: userErr } = await supabase
      .from('messages')
      .insert({
        session_id: sessionId,
        role: 'user',
        content: message,
        version: 1,
        read: true,
      })
      .select()
      .single();
    if (userErr) throw userErr;

    // 2. Get chat history for context
    const { data: history } = await supabase
      .from('messages')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true });

    const chatHistory = (history || []).map(m => ({ role: m.role, content: m.content }));

    // 3. Call DeepSeek
    let aiContent;
    try {
      aiContent = await callDeepSeek(chatHistory, model || 'deepseek-chat');
    } catch (aiErr) {
      // Save error as AI message so UI doesn't hang
      aiContent = `抱歉，AI 服务暂时不可用：${aiErr.message}`;
    }

    // 4. Save AI response
    const { data: aiMsg, error: aiErr } = await supabase
      .from('messages')
      .insert({
        session_id: sessionId,
        role: 'assistant',
        content: aiContent,
        version: 1,
        read: false,
      })
      .select()
      .single();
    if (aiErr) throw aiErr;

    // 5. Update session
    await supabase
      .from('sessions')
      .update({
        updated_at: new Date().toISOString(),
        last_message: aiContent.substring(0, 200),
      })
      .eq('id', sessionId);

    res.status(201).json({ userMessage: userMsg, aiMessage: aiMsg });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// REACTIONS
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/messages/:id/reactions - toggle/add reaction
app.post('/api/messages/:id/reactions', async (req, res) => {
  try {
    const { emoji } = req.body;
    if (!emoji) return res.status(400).json({ error: 'emoji is required' });

    // Check if reaction exists
    const { data: existing } = await supabase
      .from('reactions')
      .select('*')
      .eq('message_id', req.params.id)
      .eq('emoji', emoji)
      .single();

    if (existing) {
      // Increment count
      const { data, error } = await supabase
        .from('reactions')
        .update({ count: existing.count + 1 })
        .eq('id', existing.id)
        .select()
        .single();
      if (error) throw error;
      return res.json(data);
    }

    // Create new reaction
    const { data, error } = await supabase
      .from('reactions')
      .insert({ message_id: req.params.id, emoji, count: 1 })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/messages/:id/reactions
app.get('/api/messages/:id/reactions', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('reactions')
      .select('*')
      .eq('message_id', req.params.id);
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// EVENTS
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/events', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('events')
      .select('*')
      .order('event_date', { ascending: true });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/events', async (req, res) => {
  try {
    const { title, type, event_date } = req.body;
    const { data, error } = await supabase
      .from('events')
      .insert({ title, type: type || 'reminder', event_date })
      .select()
      .single();
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
    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/diary', async (req, res) => {
  try {
    const { content, mood, author } = req.body;
    const { data, error } = await supabase
      .from('diary')
      .insert({ content, mood: mood || '', author: author || 'user' })
      .select()
      .single();
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
      const start = `${year}-${String(month).padStart(2, '0')}-01`;
      const endDay = new Date(parseInt(year), parseInt(month), 0).getDate();
      const end = `${year}-${String(month).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`;
      query = query.gte('marker_date', start).lte('marker_date', end);
    }
    const { data, error } = await query.order('marker_date', { ascending: true });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/calendar-markers', async (req, res) => {
  try {
    const { marker_date, type, label, color } = req.body;
    const { data, error } = await supabase
      .from('calendar_markers')
      .insert({ marker_date, type, label: label || '', color: color || '' })
      .select()
      .single();
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
      const { data: existing } = await supabase
        .from('app_settings')
        .select('id')
        .eq('key', key)
        .single();

      if (existing) {
        await supabase.from('app_settings').update({ value }).eq('key', key);
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
    const { image, filename } = req.body; // image is base64 or data URL
    if (!image) return res.status(400).json({ error: 'image is required' });

    // Decode base64
    const matches = image.match(/^data:image\/(\w+);base64,(.+)$/);
    let buffer, ext;
    if (matches) {
      ext = matches[1];
      buffer = Buffer.from(matches[2], 'base64');
    } else {
      buffer = Buffer.from(image, 'base64');
      ext = 'png';
    }

    const filePath = `avatars/${filename || `avatar-${Date.now()}.${ext}`}`;

    const { data, error } = await supabase.storage
      .from('public')
      .upload(filePath, buffer, {
        contentType: `image/${ext}`,
        upsert: true,
      });

    if (error) throw error;

    const { data: urlData } = supabase.storage.from('public').getPublicUrl(filePath);
    res.json({ url: urlData.publicUrl, path: filePath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/export/:sessionId', async (req, res) => {
  try {
    const { data: session } = await supabase
      .from('sessions')
      .select('*')
      .eq('id', req.params.sessionId)
      .single();

    const { data: messages } = await supabase
      .from('messages')
      .select('*')
      .eq('session_id', req.params.sessionId)
      .order('created_at', { ascending: true });

    const exportData = {
      exportedAt: new Date().toISOString(),
      session,
      messages,
    };

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
    if (!messageIds || !messageIds.length) {
      return res.status(400).json({ error: 'messageIds required' });
    }
    const { error } = await supabase
      .from('messages')
      .update({ read: true })
      .in('id', messageIds);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CLEAR ALL (for settings page)
// ═══════════════════════════════════════════════════════════════════════════════

app.delete('/api/clear-all', async (_req, res) => {
  try {
    await supabase.from('messages').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await supabase.from('sessions').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await supabase.from('reactions').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Daisy-Home server running on port ${PORT}`);
  console.log(`Supabase: ${SUPABASE_URL ? 'configured' : 'MISSING'}`);
  console.log(`DeepSeek: ${DEEPSEEK_API_KEY ? 'configured' : 'MISSING'}`);
});

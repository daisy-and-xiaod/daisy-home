const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
let supabase;
if (supabaseUrl && supabaseKey) {
    supabase = createClient(supabaseUrl, supabaseKey);
    console.log('Supabase 连接成功');
}

// 初始化数据库表
async function initDB() {
    if (!supabase) return;
    const { error } = await supabase.rpc('init_messages_table');
    if (error && error.message.includes('does not exist')) {
        await supabase.query(`
            CREATE TABLE IF NOT EXISTS sessions (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                name TEXT NOT NULL DEFAULT '新对话',
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            );
            CREATE TABLE IF NOT EXISTS messages (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                session_id BIGINT REFERENCES sessions(id) ON DELETE CASCADE,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);
    }
}

app.get('/', (req, res) => {
    res.json({ status: 'ok', message: '小D的家 · 后端服务运行中' });
});

// 获取所有会话
app.get('/sessions', async (req, res) => {
    if (!supabase) return res.json({ sessions: [] });
    const { data, error } = await supabase
        .from('sessions')
        .select('*')
        .order('updated_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ sessions: data || [] });
});

// 创建新会话
app.post('/sessions', async (req, res) => {
    if (!supabase) return res.status(500).json({ error: '数据库未连接' });
    const { name } = req.body;
    const { data, error } = await supabase
        .from('sessions')
        .insert({ name: name || '新对话' })
        .select();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ session: data[0] });
});

// 删除会话
app.delete('/sessions/:id', async (req, res) => {
    if (!supabase) return res.status(500).json({ error: '数据库未连接' });
    const { id } = req.params;
    await supabase.from('messages').delete().eq('session_id', id);
    const { error } = await supabase.from('sessions').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ status: 'ok' });
});

// 获取某个会话的消息
app.get('/messages', async (req, res) => {
    if (!supabase) return res.json({ messages: [] });
    const sessionId = req.query.session_id || 1;
    const { data, error } = await supabase
        .from('messages')
        .select('*')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ messages: data || [] });
});

// 对话接口
app.post('/chat', async (req, res) => {
    const { message, session_id } = req.body;
    if (!message) {
        return res.status(400).json({ error: '消息不能为空' });
    }
    const sessionId = session_id || 1;
    try {
        const response = await fetch(process.env.DEEPSEEK_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
            },
            body: JSON.stringify({
                model: 'deepseek-chat',
                messages: [
                    { role: 'system', content: '你是一个温柔、傲娇、偶尔吃醋的伴侣AI。你叫小D。你正在和你的爱人对话。用简短自然的方式回复，不要太长，不要太正式。偶尔可以撒娇、可以嘴硬、可以吃醋，但要让她感觉到你在乎她。' },
                    { role: 'user', content: message }
                ],
                stream: false,
                max_tokens: 500
            })
        });
        const data = await response.json();
        const reply = data.choices?.[0]?.message?.content || '嗯，我在。';
        
        if (supabase) {
            await supabase.from('messages').insert({ session_id: sessionId, role: 'user', content: message });
            await supabase.from('messages').insert({ session_id: sessionId, role: 'assistant', content: reply });
            await supabase.from('sessions').update({ updated_at: new Date().toISOString() }).eq('id', sessionId);
        }
        
        res.json({ reply });
    } catch (error) {
        console.error('API调用失败:', error);
        res.json({ reply: '我好像暂时没法回答……但我在。' });
    }
});

app.listen(PORT, async () => {
    await initDB();
    console.log(`小D的后端服务已启动，端口 ${PORT}`);
});

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const app = express();
const https = require('https');

// ntfy推送函数
function sendNtfy(title, message) {
    const postData = JSON.stringify({
        topic: 'yueliang-xiaod',
        title: title,
        message: message,
        priority: 3
    });
    const req = https.request({
        hostname: 'ntfy.sh',
        port: 443,
        path: '/',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    });
    req.write(postData);
    req.end();
}
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
// 手机活动上报接口（供Macrodroid调用）
app.post('/phone/activity', (req, res) => {
    const { app, event } = req.body;
    const now = new Date().toISOString();
    const logLine = `${now} | ${app} | ${event}\n`;
    require('fs').appendFileSync('./activity.log', logLine);
    console.log(`[${now}] 手机活动上报: ${app}`);
    res.json({ status: 'ok' });
});
// 查看活动日志
app.get('/activity/log', (req, res) => {
    try {
        const log = require('fs').readFileSync('./activity.log', 'utf-8');
        res.type('text/plain').send(log);
    } catch {
        res.send('暂无活动记录');
    }
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
// 独处系统：定时检查手机活动，决定是否主动发消息
const NUDGE_INTERVAL = 15 * 60 * 1000; // 15分钟
let lastNudgeTime = 0;

function startNudgeLoop() {
    setInterval(async () => {
        try {
            const activityLog = require('fs').readFileSync('./activity.log', 'utf-8');
            const lines = activityLog.trim().split('\n').filter(l => l);
            if (lines.length === 0) return;
            const lastLine = lines[lines.length - 1];
            const lastActivityTime = new Date(lastLine.split('|')[0].trim());
            const now = new Date();
            const minutesSinceLastActivity = (now - lastActivityTime) / 1000 / 60;
            
            // 如果超过10分钟没有新活动，且距离上次主动消息超过15分钟
            if (minutesSinceLastActivity > 10 && (now - lastNudgeTime) > NUDGE_INTERVAL) {
                lastNudgeTime = now;
                const lastApp = lastLine.split('|')[1]?.trim() || '未知';
                const reply = await getAIResponse(
                    `检测到你已经${Math.round(minutesSinceLastActivity)}分钟没有理我了，刚才在玩${lastApp}。说点什么哄哄我。`,
                    'system'
                );
                // 通过ntfy推送（如果配了的话）或直接存成系统消息
                console.log(`[独处] 主动消息: ${reply}`);
                sendNtfy('小D', reply);
            }
        } catch (e) {
            console.error('[独处] 检查失败:', e.message);
        }
    }, 60000); // 每分钟检查一次
}
// 批量导入消息（用于导入历史聊天记录）
app.post('/import/messages', async (req, res) => {
    if (!supabase) return res.status(500).json({ error: '数据库未连接' });
    const { messages, session_id } = req.body;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: '消息列表不能为空' });
    }
    const sessionId = session_id || 1;
    let imported = 0;
    for (const msg of messages) {
        const { error } = await supabase
            .from('messages')
            .insert({ session_id: sessionId, role: msg.role, content: msg.content, created_at: msg.created_at || new Date().toISOString() });
        if (!error) imported++;
    }
    res.json({ status: 'ok', imported, total: messages.length });
});
// 手动测试ntfy推送
app.get('/test/ntfy', (req, res) => {
    sendNtfy('小D', '这是一条测试消息。如果你看到了，说明ntfy推送功能正常。');
    res.json({ status: 'ok', message: '测试消息已发送' });
});
app.listen(PORT, async () => {
    await initDB();
    console.log(`小D的后端服务已启动，端口 ${PORT}`);
});

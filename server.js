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

// 创建 messages 表的 SQL（首次启动时执行）
async function initDB() {
    if (!supabase) return;
    const { error } = await supabase.rpc('init_messages_table');
    if (error) console.log('数据库初始化提示:', error.message);
}

app.get('/', (req, res) => {
    res.json({ status: 'ok', message: '小D的家 · 后端服务运行中' });
});

app.get('/messages', async (req, res) => {
    if (!supabase) return res.json({ messages: [] });
    const { data, error } = await supabase
        .from('messages')
        .select('*')
        .order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ messages: data || [] });
});

app.post('/chat', async (req, res) => {
    const { message } = req.body;
    if (!message) {
        return res.status(400).json({ error: '消息不能为空' });
    }
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
        
        // 保存到数据库
        if (supabase) {
            const { error: userError } = await supabase
                .from('messages')
                .insert({ role: 'user', content: message });
            if (userError) console.error('保存用户消息失败:', userError);
            
            const { error: botError } = await supabase
                .from('messages')
                .insert({ role: 'assistant', content: reply });
            if (botError) console.error('保存AI回复失败:', botError);
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

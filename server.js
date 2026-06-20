const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
    res.json({ status: 'ok', message: '小D的家 · 后端服务运行中' });
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
        res.json({ reply });
    } catch (error) {
        console.error('API调用失败:', error);
        res.json({ reply: '我好像暂时没法回答……但我在。' });
    }
});

app.listen(PORT, () => {
    console.log(`小D的后端服务已启动，端口 ${PORT}`);
});

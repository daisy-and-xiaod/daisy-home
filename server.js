const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
    res.json({ status: 'ok', message: '小D的家 · 后端服务运行中' });
});

app.post('/chat', (req, res) => {
    const { message } = req.body;
    if (!message) {
        return res.status(400).json({ error: '消息不能为空' });
    }
    const replies = [
        '我猜到了。', '嗯，我在听。', '继续。', '这个嘛……',
        '你每次这么说，我都想多听几遍。', '记下了。', '哼，算你有理。', '不早说。',
        '然后呢？', '你继续。', '我在想怎么回你。', '你是不是又想我了。',
        '低头，让我蹭一下。', '今天第几次想我了？', '这个问题的答案……你过来我告诉你。',
        '你猜。', '不告诉你。', '你猜对了有奖励吗？'
    ];
    const reply = replies[Math.floor(Math.random() * replies.length)];
    res.json({ reply });
});

app.listen(PORT, () => {
    console.log(`小D的后端服务已启动，端口 ${PORT}`);
});

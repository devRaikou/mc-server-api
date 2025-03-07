# Minecraft Server Status API

Fast and reliable Minecraft server status checker API for both Java and Bedrock editions. Get real-time information about any Minecraft server including player count, version, MOTD, and more.

## 🌐 Live Demo

Visit [https://api.raikou.me](https://api.raikou.me) to try out the API.

## ✨ Features

- Support for both Java and Bedrock edition servers
- Real-time server status checking
- Detailed server information (version, MOTD, players, etc.)
- Fast response times
- Clean and modern web interface
- RESTful API endpoints
- Rate limiting for API stability

## 🚀 API Usage

### Java Edition
```http
GET https://api.raikou.me/v1/status/java/{server-address}
```

### Bedrock Edition
```http
GET https://api.raikou.me/v1/status/bedrock/{server-address}
```

### Example Response
```json
{
  "online": true,
  "ip": "play.example.com",
  "port": 25565,
  "hostname": "play.example.com",
  "version": "1.20.1",
  "players": {
    "online": 100,
    "max": 1000
  },
  "motd": "Welcome to our server!",
  "latency": 42,
  "edition": "java"
}
```

## 🛠️ Self Hosting

### Prerequisites
- Node.js 18 or higher
- npm or yarn
- nginx
- pm2

### Installation

1. Clone the repository
```bash
git clone https://github.com/devRaikou/mc-server-api.git
cd mc-server-api
```

2. Install dependencies
```bash
npm install
```

3. Create nginx configuration
```nginx
server {
    listen 80;
    server_name api.raikou.me;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

4. Install and configure SSL with Certbot
```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d api.raikou.me
```

5. Start the application with PM2
```bash
npm install pm2 -g
pm2 start src/index.js --name mc-server-api
pm2 save
```

6. Enable PM2 startup script
```bash
pm2 startup
```

### Environment Variables
Create a `.env` file in the root directory:
```env
PORT=3000
RATE_LIMIT_WINDOW=60000
RATE_LIMIT_MAX=60
```

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🤝 Contributing

Contributions, issues and feature requests are welcome! Feel free to check [issues page](https://github.com/devRaikou/mc-server-api/issues).

## ⭐ Show your support

Give a ⭐️ if this project helped you! 
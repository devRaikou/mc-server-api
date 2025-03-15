import express from 'express';
import net from 'net';
import dns from 'dns';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';
import dgram from 'dgram';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const resolveDns = promisify(dns.resolve4);
const app = express();
const PORT = process.env.PORT || 3001;

// Status monitoring variables
let startTime = Date.now();
let javaResponseTimes = [];
let bedrockResponseTimes = [];

app.use(express.static(path.join(__dirname, '../public')));

const PACKET_HANDSHAKE = 0x00;
const PACKET_STATUS_REQUEST = 0x00;
const PROTOCOL_VERSION = 47; // 1.8+ protokolü

const BEDROCK_PACKET = Buffer.from([
  0x01, // Protocol version
  0x00, // Packet ID
  0x00, 0x00, 0x00, 0x00, // Session ID
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // Request ID
  0xff, 0xff, 0xff, 0xff  // Payload
]);

const RAKNET_MAGIC = Buffer.from([
  0x00, 0xff, 0xff, 0x00,
  0xfe, 0xfe, 0xfe, 0xfe,
  0xfd, 0xfd, 0xfd, 0xfd,
  0x12, 0x34, 0x56, 0x78
]);

const UNCONNECTED_PING = Buffer.from([0x01]);

class MinecraftServerStatus {
  constructor(host, port = 25565, type = 'java') {
    this.host = host;
    this.port = port;
    this.type = type.toLowerCase();
    this.debugMode = false;
  }

  // Debug log fonksiyonu
  debug(message, data = null) {
    if (this.debugMode) {
      console.log(`[Debug] ${message}`, data || '');
    }
  }

  // VarInt okuma fonksiyonu
  readVarInt(buffer, offset) {
    let numRead = 0;
    let result = 0;
    let byte;

    do {
      if (offset + numRead >= buffer.length) {
        throw new Error("Buffer overflow while reading VarInt");
      }
      byte = buffer[offset + numRead];
      result |= (byte & 0x7F) << (7 * numRead);
      numRead++;
      if (numRead > 5) {
        throw new Error("VarInt is too big");
      }
    } while ((byte & 0x80) != 0);

    return { value: result, bytesRead: numRead };
  }

  // VarInt'i buffer'a yazma fonksiyonu
  writeVarInt(value) {
    const buffer = [];
    while (true) {
      if ((value & ~0x7F) === 0) {
        buffer.push(value);
        break;
      }
      buffer.push(((value & 0x7F) | 0x80));
      value >>>= 7;
    }
    return Buffer.from(buffer);
  }

  // String'i buffer'a yazma fonksiyonu
  writeString(value) {
    const stringBuffer = Buffer.from(value, 'utf8');
    return Buffer.concat([
      this.writeVarInt(stringBuffer.length),
      stringBuffer
    ]);
  }

  // Handshake paketini oluşturma
  createHandshakePacket() {
    const packetId = Buffer.from([PACKET_HANDSHAKE]);
    const protocolVersion = this.writeVarInt(PROTOCOL_VERSION);
    const hostLength = this.writeString(this.host);
    const portBuffer = Buffer.alloc(2);
    portBuffer.writeUInt16BE(this.port);
    const nextState = Buffer.from([0x01]);

    const data = Buffer.concat([
      packetId,
      protocolVersion,
      hostLength,
      portBuffer,
      nextState
    ]);

    return Buffer.concat([
      this.writeVarInt(data.length),
      data
    ]);
  }

  // Status request paketini oluşturma
  createStatusRequestPacket() {
    const packetId = Buffer.from([PACKET_STATUS_REQUEST]);
    const length = this.writeVarInt(1);
    return Buffer.concat([length, packetId]);
  }

  parsePacket(buffer) {
    try {
      let offset = 0;
      
      // İlk olarak paket uzunluğunu oku
      const lengthResult = this.readVarInt(buffer, offset);
      const totalLength = lengthResult.value;
      offset += lengthResult.bytesRead;

      // Eğer buffer yeterli uzunlukta değilse, daha fazla veri bekle
      if (buffer.length < offset + totalLength) {
        this.debug(`Buffer too short: ${buffer.length} < ${offset + totalLength}`);
        return null;
      }

      // Paket ID'sini oku
      const packetIdResult = this.readVarInt(buffer, offset);
      offset += packetIdResult.bytesRead;

      // String uzunluğunu oku
      const stringLengthResult = this.readVarInt(buffer, offset);
      offset += stringLengthResult.bytesRead;

      // String verisi için yeterli veri var mı kontrol et
      if (buffer.length < offset + stringLengthResult.value) {
        this.debug(`String data incomplete: ${buffer.length} < ${offset + stringLengthResult.value}`);
        return null;
      }

      // JSON verisini çıkar
      const jsonData = buffer.slice(offset, offset + stringLengthResult.value).toString('utf8');
      
      try {
        const parsed = JSON.parse(jsonData);
        this.debug('JSON parse successful');
        return parsed;
      } catch (parseError) {
        this.debug('Parse error:', parseError.message);
        this.debug('Raw JSON data:', jsonData);
        throw new Error("Invalid JSON format");
      }
    } catch (err) {
      if (err.message.includes("Buffer overflow")) {
        return null;
      }
      throw err;
    }
  }

  // Java sunucu durumunu kontrol etme
  async getJavaStatus() {
    let resolvedIp = this.host;
    try {
      const ips = await resolveDns(this.host);
      resolvedIp = ips[0];
      this.debug('DNS resolved', { host: this.host, ip: resolvedIp });
    } catch (err) {
      this.debug('DNS resolution failed', err.message);
    }

    return new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      let startTime = Date.now();
      let retries = 0;
      const maxRetries = 3;

      const tryConnect = () => {
        const socket = new net.Socket();
        let timeout = null;

        socket.on('connect', () => {
          this.debug(`Connection attempt ${retries + 1} of ${maxRetries}`);
          this.debug('Socket connected');
          
          // Handshake ve status paketlerini gönder
          socket.write(this.createHandshakePacket());
          socket.write(this.createStatusRequestPacket());
        });

        socket.on('data', (data) => {
          buffer = Buffer.concat([buffer, data]);
          this.debug(`Received data chunk: ${data.length}`);

          try {
            const response = this.parsePacket(buffer);
            if (response) {
              clearTimeout(timeout);
              socket.destroy();

              // MOTD işleme
              let motd = {
                raw: '',
                clean: '',
                html: ''
              };

              // MOTD raw formatını oluştur
              if (typeof response.description === 'object') {
                if (response.description.text || response.description.extra) {
                  let motdText = response.description.text || '';
                  if (response.description.extra) {
                    response.description.extra.forEach(part => {
                      if (part.text) motdText += part.text;
                    });
                  }
                  motd.raw = motdText;
                }
              } else {
                motd.raw = response.description || '';
              }

              // MOTD boş kontrolü
              if (!motd.raw.trim()) {
                motd = {
                  raw: 'No MOTD available',
                  clean: 'No MOTD available',
                  html: '<span class="no-motd">No MOTD available</span>'
                };
              } else {
                // Clean versiyonu oluştur (renk kodları olmadan)
                motd.clean = motd.raw.replace(/§[0-9a-fklmnor]/g, '');
                // HTML versiyonunu oluştur
                motd.html = this.convertMotdToHtml(motd.raw);
              }

              // Versiyon bilgisini düzenle
              const version = typeof response.version === 'object' ? 
                response.version.name || 'Unknown' :
                response.version || 'Unknown';

              const result = {
                status: 'online',
                host: this.host,
                ip: resolvedIp,
                port: this.port,
                edition: 'java',
                version: version,
                protocol: response.version?.protocol || 0,
                latency: Date.now() - startTime,
                players: {
                  online: response.players?.online || 0,
                  max: response.players?.max || 0,
                  list: response.players?.sample || []
                },
                motd: motd,
                favicon: response.favicon || null
              };

              resolve(result);
            }
          } catch (err) {
            this.debug('Parse error:', err.message);
            clearTimeout(timeout);
            socket.destroy();
            
            if (retries < maxRetries - 1) {
              retries++;
              tryConnect();
            } else {
              resolve({
                status: 'error',
                error: 'Failed to parse server response',
                host: this.host,
                ip: resolvedIp,
                port: this.port,
                edition: 'java'
              });
            }
          }
        });

        socket.on('error', (err) => {
          this.debug('Socket error:', err.message);
          clearTimeout(timeout);
          socket.destroy();

          if (retries < maxRetries - 1) {
            retries++;
            tryConnect();
          } else {
            resolve({
              status: 'offline',
              error: err.message,
              host: this.host,
              ip: resolvedIp,
              port: this.port,
              edition: 'java'
            });
          }
        });

        // 5 saniye timeout
        timeout = setTimeout(() => {
          socket.destroy();
          if (retries < maxRetries - 1) {
            retries++;
            tryConnect();
          } else {
            resolve({
              status: 'offline',
              error: 'Connection timeout',
              host: this.host,
              ip: resolvedIp,
              port: this.port,
              edition: 'java'
            });
          }
        }, 5000);

        socket.connect(this.port, resolvedIp);
      };

      tryConnect();
    });
  }

  // MOTD'yi HTML'e çevirme fonksiyonu
  convertMotdToHtml(text) {
    if (!text || !text.trim()) {
      return '<span class="no-motd">No MOTD available</span>';
    }

    const colorCodes = {
      '0': '#000000', '1': '#0000AA', '2': '#00AA00', '3': '#00AAAA',
      '4': '#AA0000', '5': '#AA00AA', '6': '#FFAA00', '7': '#AAAAAA',
      '8': '#555555', '9': '#5555FF', 'a': '#55FF55', 'b': '#55FFFF',
      'c': '#FF5555', 'd': '#FF55FF', 'e': '#FFFF55', 'f': '#FFFFFF'
    };

    let html = '';
    let currentSpan = '';
    let isCode = false;
    let currentColor = 'white';
    let isBold = false;
    let isItalic = false;
    let isUnderline = false;
    let isObfuscated = false;
    let isNewLine = false;

    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\n') {
        if (currentSpan) {
          html += `<span style="color: ${currentColor}${isBold ? ';font-weight:bold' : ''}${isItalic ? ';font-style:italic' : ''}${isUnderline ? ';text-decoration:underline' : ''}" ${isObfuscated ? 'class="font-obfuscated"' : ''}>${currentSpan}</span>`;
          currentSpan = '';
        }
        html += '<br>';
        isNewLine = true;
        continue;
      }

      if (text[i] === '§' && i + 1 < text.length) {
        isCode = true;
        if (currentSpan) {
          html += `<span style="color: ${currentColor}${isBold ? ';font-weight:bold' : ''}${isItalic ? ';font-style:italic' : ''}${isUnderline ? ';text-decoration:underline' : ''}" ${isObfuscated ? 'class="font-obfuscated"' : ''}>${currentSpan}</span>`;
          currentSpan = '';
        }
        continue;
      }

      if (isCode) {
        const code = text[i].toLowerCase();
        if (colorCodes[code]) {
          currentColor = colorCodes[code];
          isBold = isItalic = isUnderline = isObfuscated = false;
        } else if (code === 'l') isBold = true;
        else if (code === 'o') isItalic = true;
        else if (code === 'n') isUnderline = true;
        else if (code === 'k') isObfuscated = true;
        else if (code === 'r') {
          currentColor = 'white';
          isBold = isItalic = isUnderline = isObfuscated = false;
        }
        isCode = false;
        continue;
      }

      currentSpan += text[i];
    }

    if (currentSpan) {
      html += `<span style="color: ${currentColor}${isBold ? ';font-weight:bold' : ''}${isItalic ? ';font-style:italic' : ''}${isUnderline ? ';text-decoration:underline' : ''}" ${isObfuscated ? 'class="font-obfuscated"' : ''}>${currentSpan}</span>`;
    }

    return html || '<span class="no-motd">No MOTD available</span>';
  }

  // Bedrock sunucu durumunu kontrol etme
  async getBedrockStatus() {
    let resolvedIp = this.host;
    try {
      const ips = await resolveDns(this.host);
      resolvedIp = ips[0];
      this.debug('DNS resolved', { host: this.host, ip: resolvedIp });
    } catch (err) {
      this.debug('DNS resolution failed', err.message);
      resolvedIp = this.host;
    }

    return new Promise((resolve, reject) => {
      const client = dgram.createSocket('udp4');
      let startTime = Date.now();
      let timeout = null;
      let responseReceived = false;

      // Ping paketi oluştur
      const timestamp = Buffer.alloc(8);
      const now = BigInt(Date.now());
      timestamp.writeBigInt64LE(now);

      const pingPacket = Buffer.concat([
        UNCONNECTED_PING,
        timestamp,
        RAKNET_MAGIC
      ]);

      client.on('message', (msg) => {
        responseReceived = true;
        clearTimeout(timeout);
        
        try {
          // İlk byte kontrol
          if (msg[0] !== 0x1C) {
            throw new Error('Invalid response packet');
          }

          // RAKNET_MAGIC kontrolü
          const magicStart = 17;
          const magicEnd = magicStart + RAKNET_MAGIC.length;
          if (!msg.slice(magicStart, magicEnd).equals(RAKNET_MAGIC)) {
            throw new Error('Invalid magic bytes');
          }

          // Sunucu bilgilerini ayır
          const serverData = msg.slice(magicEnd).toString('utf-8');
          const serverInfo = serverData.split(';');
          
          if (serverInfo.length < 6) {
            throw new Error('Incomplete server info');
          }

          // Sunucu bilgilerini parse et
          const [
            edition,
            motdLine1,
            protocolVersion,
            versionName,
            onlinePlayers,
            maxPlayers,
            serverGuid,
            motdLine2,
            gamemode = '',
            gamemodeNumeric = '1',
            portIPv4 = '',
            portIPv6 = ''
          ] = serverInfo;

          // MOTD'yi birleştir
          const motdText = motdLine2 ? `${motdLine1}\n${motdLine2}` : motdLine1;

          // MOTD'yi işle
          const motd = {
            raw: motdText || 'No MOTD available',
            clean: (motdText || 'No MOTD available').replace(/§[0-9a-fklmnor]/g, ''),
            html: this.convertMotdToHtml(motdText || 'No MOTD available')
          };

          client.close();
          
          resolve({
            status: 'online',
            host: this.host,
            ip: resolvedIp,
            port: this.port,
            edition: 'bedrock',
            version: {
              name: versionName || 'Unknown',
              protocol: parseInt(protocolVersion) || 0
            },
            players: {
              online: parseInt(onlinePlayers) || 0,
              max: parseInt(maxPlayers) || 0,
              list: []
            },
            motd: motd,
            gamemode: gamemode || 'Unknown',
            latency: Date.now() - startTime
          });
        } catch (err) {
          this.debug('Error parsing Bedrock response:', err.message);
          client.close();
          resolve({
            status: 'error',
            error: 'Failed to parse server response',
            host: this.host,
            ip: resolvedIp,
            port: this.port,
            edition: 'bedrock'
          });
        }
      });

      client.on('error', (err) => {
        clearTimeout(timeout);
        client.close();
        if (!responseReceived) {
          resolve({
            status: 'offline',
            error: err.message,
            host: this.host,
            ip: resolvedIp,
            port: this.port,
            edition: 'bedrock'
          });
        }
      });

      // Ping gönder ve yeniden deneme mekanizması
      let retryCount = 0;
      const maxRetries = 3;
      const retryInterval = 1000;
      
      const sendPing = () => {
        try {
          client.send(pingPacket, this.port, resolvedIp, (err) => {
            if (err) {
              this.debug('Send error:', err.message);
              if (retryCount < maxRetries) {
                retryCount++;
                setTimeout(sendPing, retryInterval);
              } else {
                client.close();
                resolve({
                  status: 'error',
                  error: err.message,
                  host: this.host,
                  ip: resolvedIp,
                  port: this.port,
                  edition: 'bedrock'
                });
              }
            }
          });
        } catch (err) {
          this.debug('Send error:', err.message);
          client.close();
          resolve({
            status: 'error',
            error: err.message,
            host: this.host,
            ip: resolvedIp,
            port: this.port,
            edition: 'bedrock'
          });
        }
      };

      // İlk ping'i gönder
      sendPing();

      // 5 saniye timeout
      timeout = setTimeout(() => {
        if (!responseReceived) {
          client.close();
          resolve({
            status: 'offline',
            error: 'Connection timeout',
            host: this.host,
            ip: resolvedIp,
            port: this.port,
            edition: 'bedrock'
          });
        }
      }, 5000);
    });
  }

  // Sunucu durumunu kontrol etme
  async getStatus() {
    if (this.type === 'bedrock') {
      return this.getBedrockStatus();
    }
    
    // Mevcut Java Edition kontrolü devam eder...
    let resolvedIp = this.host;
    try {
      const ips = await resolveDns(this.host);
      resolvedIp = ips[0];
      this.debug('DNS resolved', { host: this.host, ip: resolvedIp });
    } catch (err) {
      this.debug('DNS resolution failed', err.message);
    }

    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let responseData = Buffer.alloc(0);
      let packetReceived = false;
      let startTime = 0;
      let connectionAttempts = 0;
      const maxAttempts = 3;
      let currentTimeout = null;

      const tryConnect = () => {
        connectionAttempts++;
        this.debug(`Connection attempt ${connectionAttempts} of ${maxAttempts}`);
        
        if (connectionAttempts > maxAttempts) {
          socket.destroy();
          resolve({
            status: 'offline',
            error: `Failed after ${maxAttempts} connection attempts`,
            hostname: this.host,
            ip: resolvedIp,
            port: this.port,
            dns_resolved: resolvedIp !== this.host,
            attempts: connectionAttempts
          });
          return;
        }

        socket.connect(this.port, resolvedIp);
      };

      const clearCurrentTimeout = () => {
        if (currentTimeout) {
          clearTimeout(currentTimeout);
          currentTimeout = null;
        }
      };

      socket.on('connect', () => {
        this.debug('Socket connected');
        startTime = Date.now();
        responseData = Buffer.alloc(0);
        
        // Handshake paketini gönder
        const handshakePacket = this.createHandshakePacket();
        socket.write(handshakePacket);
        
        // Status request paketini gönder
        const statusPacket = this.createStatusRequestPacket();
        socket.write(statusPacket);

        // 3 saniye timeout başlat
        currentTimeout = setTimeout(() => {
          if (!packetReceived) {
            socket.destroy();
          }
        }, 3000);
      });

      socket.on('data', (data) => {
        this.debug('Received data chunk:', data.length, 'bytes');
        responseData = Buffer.concat([responseData, data]);

        try {
          const response = this.parsePacket(responseData);
          if (response) {
            packetReceived = true;
            clearCurrentTimeout();

            // MOTD işleme
            let motd = {
              raw: '',
              clean: '',
              html: ''
            };

            // MOTD raw formatını oluştur
            if (typeof response.description === 'object') {
              if (response.description.text || response.description.extra) {
                let motdText = response.description.text || '';
                if (response.description.extra) {
                  response.description.extra.forEach(part => {
                    if (part.text) motdText += part.text;
                  });
                }
                motd.raw = motdText;
              }
            } else {
              motd.raw = response.description || '';
            }

            // MOTD boş kontrolü
            if (!motd.raw.trim()) {
              motd = {
                raw: 'No MOTD available',
                clean: 'No MOTD available',
                html: '<span class="no-motd">No MOTD available</span>'
              };
            } else {
              // Clean versiyonu oluştur (renk kodları olmadan)
              motd.clean = motd.raw.replace(/§[0-9a-fklmnor]/g, '');
              // HTML versiyonunu oluştur
              motd.html = this.convertMotdToHtml(motd.raw);
            }

            // Versiyon bilgisini düzenle
            const version = typeof response.version === 'object' ? 
              response.version.name || 'Unknown' :
              response.version || 'Unknown';

            const result = {
              status: 'online',
              players: {
                online: response.players?.online || 0,
                max: response.players?.max || 0,
                sample: response.players?.sample || []
              },
              version: version,
              protocol: response.version?.protocol || 0,
              motd: motd,
              favicon: response.favicon || null,
              hostname: this.host,
              ip: resolvedIp,
              port: this.port,
              latency: Date.now() - startTime,
              connection_attempts: connectionAttempts
            };

            socket.destroy();
            resolve(result);
          }
        } catch (err) {
          this.debug('Error processing response:', err.message);
          if (responseData.length > 16384) { // 16KB limit
            socket.destroy();
            resolve({
              status: 'error',
              error: 'Response too large',
              hostname: this.host,
              ip: resolvedIp,
              port: this.port
            });
          }
        }
      });

      socket.on('error', (err) => {
        this.debug('Socket error:', err.message);
        clearCurrentTimeout();
        
        if (connectionAttempts < maxAttempts) {
          socket.destroy();
          setTimeout(tryConnect, 1000);
        } else {
          resolve({
            status: 'offline',
            error: err.message,
            error_code: err.code,
            hostname: this.host,
            ip: resolvedIp,
            port: this.port,
            dns_resolved: resolvedIp !== this.host,
            attempts: connectionAttempts
          });
        }
      });

      socket.on('timeout', () => {
        this.debug('Socket timeout');
        clearCurrentTimeout();
        
        if (connectionAttempts < maxAttempts) {
          socket.destroy();
          setTimeout(tryConnect, 1000);
        } else {
          socket.destroy();
          resolve({
            status: 'offline',
            error: 'Connection timeout',
            hostname: this.host,
            ip: resolvedIp,
            port: this.port,
            dns_resolved: resolvedIp !== this.host,
            attempts: connectionAttempts
          });
        }
      });

      socket.setTimeout(5000);
      tryConnect();
    });
  }
}

// API endpoint'lerini tanımla
app.get('/v1/status/:edition/:host', async (req, res) => {
  const { edition, host } = req.params;
  const { port, debug = false } = req.query;

  if (!host) {
    return res.status(400).json({
      error: 'Host parameter is required'
    });
  }

  if (!['java', 'bedrock'].includes(edition.toLowerCase())) {
    return res.status(400).json({
      error: 'Invalid edition type. Must be either "java" or "bedrock"'
    });
  }

  // Edition'a göre varsayılan port belirle
  const defaultPort = edition.toLowerCase() === 'bedrock' ? 19132 : 25565;
  const serverPort = parseInt(port) || defaultPort;

  try {
    const checker = new MinecraftServerStatus(host, serverPort, edition);
    checker.debugMode = debug === 'true';
    const status = await checker.getStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({
      error: 'Internal server error',
      message: err.message
    });
  }
});

// API kullanım bilgisi
app.get('/api', (req, res) => {
  res.json({
    name: 'Minecraft Server Status API',
    version: '1.0.0',
    description: 'Check status of both Java and Bedrock Minecraft servers',
    endpoints: {
      status: {
        url: '/v1/status/:edition/:host',
        method: 'GET',
        parameters: {
          edition: {
            type: 'string',
            required: true,
            enum: ['java', 'bedrock'],
            description: 'Server edition type (java or bedrock)'
          },
          host: {
            type: 'string',
            required: true,
            description: 'Server address or IP (e.g., play.example.com)'
          },
          port: {
            type: 'number',
            required: false,
            description: 'Server port (Default: 25565 for Java, 19132 for Bedrock)'
          },
          debug: {
            type: 'boolean',
            required: false,
            default: false,
            description: 'Enable debug mode'
          }
        },
        examples: {
          java: '/v1/status/java/mc.hypixel.net',
          bedrock: '/v1/status/bedrock/play.example.com',
          custom: '/v1/status/java/play.example.com?port=25565&debug=true'
        }
      }
    }
  });
});

// CORS desteği ekle
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// Ana sayfayı serve et
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Status sayfasını serve et
app.get('/status', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/status.html'));
});

// API rehber sayfasını serve et
app.get('/guide', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/guide.html'));
});

// Status API endpoint
app.get('/api/status', async (req, res) => {
  try {
    // Test sunucularının durumunu kontrol et
    const testServers = {
      java: { host: 'mc.hypixel.net', port: 25565 },
      bedrock: { host: 'play.craftersmc.net', port: 19132 }
    };

    const javaStatus = new MinecraftServerStatus(testServers.java.host, testServers.java.port, 'java');
    const bedrockStatus = new MinecraftServerStatus(testServers.bedrock.host, testServers.bedrock.port, 'bedrock');

    // Her sunucu için ayrı ayrı kontrol et
    let javaResult, bedrockResult;

    try {
      javaResult = await javaStatus.getStatus();
    } catch (error) {
      console.error('Java status check error:', error);
      javaResult = { status: 'error', latency: 0 };
    }

    try {
      bedrockResult = await bedrockStatus.getBedrockStatus();
    } catch (error) {
      console.error('Bedrock status check error:', error);
      bedrockResult = { status: 'error', latency: 0 };
    }

    // Java sunucu durumu
    const javaResponse = {
      status: javaResult.status === 'online' ? 'active' : 'error',
      responseTime: javaResult.latency || 0,
      players: javaResult.players || null
    };

    if (javaResponse.responseTime > 0) {
      javaResponseTimes.push(javaResponse.responseTime);
      if (javaResponseTimes.length > 100) javaResponseTimes.shift();
    }

    // Bedrock sunucu durumu
    const bedrockResponse = {
      status: bedrockResult.status === 'online' ? 'active' : 'error',
      responseTime: bedrockResult.latency || 0,
      players: bedrockResult.players || null
    };

    if (bedrockResponse.responseTime > 0) {
      bedrockResponseTimes.push(bedrockResponse.responseTime);
      if (bedrockResponseTimes.length > 100) bedrockResponseTimes.shift();
    }

    // Genel sistem durumu
    const systemStatus = (javaResponse.status === 'active' || bedrockResponse.status === 'active') ? 'operational' : 'error';
    const uptime = Math.floor((Date.now() - startTime) / 1000);

    res.json({
      status: systemStatus,
      uptime: uptime,
      java: javaResponse,
      bedrock: bedrockResponse,
      timestamp: Date.now()
    });
  } catch (error) {
    console.error('Status check error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      java: { status: 'error', responseTime: 0, players: null },
      bedrock: { status: 'error', responseTime: 0, players: null },
      timestamp: Date.now()
    });
  }
});

// Response time monitoring middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (req.path.includes('/java')) {
      javaResponseTimes.push(duration);
      if (javaResponseTimes.length > 100) javaResponseTimes.shift();
    } else if (req.path.includes('/bedrock')) {
      bedrockResponseTimes.push(duration);
      if (bedrockResponseTimes.length > 100) bedrockResponseTimes.shift();
    }
  });
  next();
});

// Sunucuyu başlat
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
}); 
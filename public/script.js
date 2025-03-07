document.addEventListener('DOMContentLoaded', () => {
    const serverInput = document.querySelector('#serverInput');
    const editionSelect = document.querySelector('#editionSelect');
    const checkButton = document.querySelector('#checkButton');
    const resultContainer = document.querySelector('#resultContainer');
    const errorContainer = document.querySelector('#errorContainer');
    const serverCards = document.querySelectorAll('.server-card');

    // Hide result and error containers initially
    resultContainer.style.display = 'none';
    errorContainer.style.display = 'none';

    // Function to show loading state
    const showLoading = () => {
        checkButton.disabled = true;
        checkButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
        resultContainer.style.display = 'none';
        errorContainer.style.display = 'none';
    };

    // Function to hide loading state
    const hideLoading = () => {
        checkButton.disabled = false;
        checkButton.innerHTML = 'Submit';
    };

    // Function to show error
    const showError = (message) => {
        errorContainer.style.display = 'block';
        errorContainer.querySelector('.error-message').textContent = message;
        resultContainer.style.display = 'none';
    };

    // Function to format latency
    const formatLatency = (latency) => {
        if (latency < 100) return `${latency}ms`;
        if (latency < 200) return `${latency}ms`;
        return `${latency}ms`;
    };

    // Function to convert Minecraft color codes to HTML
    const convertMinecraftColors = (text) => {
        if (!text) return '<span class="no-motd">No MOTD available</span>';
        
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

        for (let i = 0; i < text.length; i++) {
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
    };

    // Function to show result
    const showResult = (data) => {
        resultContainer.style.display = 'block';

        // Update page title
        document.title = `${data.hostname || data.host || 'Unknown Server'} - Minecraft Server Status | devRaikou`;

        // Update favicon
        const faviconContainer = document.querySelector('.server-favicon');
        if (data.favicon) {
            faviconContainer.innerHTML = `<img src="${data.favicon}" alt="Server Favicon">`;
            // Update page favicon if server has one
            const existingFavicon = document.querySelector('link[rel="icon"]');
            if (existingFavicon) {
                existingFavicon.href = data.favicon;
            } else {
                const favicon = document.createElement('link');
                favicon.rel = 'icon';
                favicon.href = data.favicon;
                document.head.appendChild(favicon);
            }
        } else {
            faviconContainer.innerHTML = '<i class="fas fa-cube"></i>';
            // Keep the default favicon when server has none
        }

        // Update server info
        const serverIp = document.querySelector('.server-ip');
        const serverPort = document.querySelector('.server-port');
        
        // Hostname/IP gösterimi
        let displayText = data.hostname || data.host || 'Unknown';
        if (data.ip && data.ip !== displayText) {
            displayText = `${displayText} (${data.ip}${data.port ? `:${data.port}` : ''})`;
        } else if (data.port) {
            displayText = `${displayText}:${data.port}`;
        }
        serverIp.textContent = displayText;
        serverPort.textContent = ''; // Port artık IP ile birlikte gösteriliyor
        
        // Status badge güncelleme
        const statusBadge = document.querySelector('.status-badge');
        if (data.status === 'online') {
            statusBadge.className = 'status-badge online';
            statusBadge.innerHTML = '<i class="fas fa-check-circle"></i> Online';
        } else {
            statusBadge.className = 'status-badge offline';
            statusBadge.innerHTML = '<i class="fas fa-times-circle"></i> Offline';
        }
        
        // Version gösterimi
        const versionElement = document.querySelector('.server-version');
        if (typeof data.version === 'object' && data.version.name) {
            versionElement.textContent = data.version.name;
        } else if (typeof data.version === 'string') {
            versionElement.textContent = data.version;
        } else {
            versionElement.textContent = 'Unknown';
        }
        
        document.querySelector('.server-latency').textContent = formatLatency(data.latency || 0);

        // Oyuncu sayısı kontrolü ve gösterimi
        const playersCount = document.querySelector('.players-count');
        if (data.players && typeof data.players.online !== 'undefined' && typeof data.players.max !== 'undefined') {
            playersCount.textContent = `${data.players.online}/${data.players.max}`;
        } else {
            playersCount.textContent = 'N/A';
        }

        // MOTD gösterimi
        const motdContent = document.querySelector('.motd-content');
        if (data.motd) {
            if (typeof data.motd === 'object') {
                if (data.motd.html) {
                    // API'den gelen HTML formatını kullan
                    motdContent.innerHTML = data.motd.html;
                } else if (data.motd.raw) {
                    // Raw MOTD'yi HTML'e çevir
                    const lines = data.motd.raw.split('\n');
                    const htmlLines = lines.map(line => convertMinecraftColors(line));
                    motdContent.innerHTML = htmlLines.join('<br>');
                } else {
                    motdContent.innerHTML = '<span class="no-motd">No MOTD available</span>';
                }
            } else if (typeof data.motd === 'string') {
                if (!data.motd.trim()) {
                    motdContent.innerHTML = '<span class="no-motd">No MOTD available</span>';
                } else {
                    // String MOTD'yi HTML'e çevir
                    const lines = data.motd.split('\n');
                    const htmlLines = lines.map(line => convertMinecraftColors(line));
                    motdContent.innerHTML = htmlLines.join('<br>');
                }
            } else {
                motdContent.innerHTML = '<span class="no-motd">No MOTD available</span>';
            }
        } else {
            motdContent.innerHTML = '<span class="no-motd">No MOTD available</span>';
        }

        // Scroll to result
        resultContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    // Function to format JSON with syntax highlighting
    const formatJSON = (obj) => {
        const json = JSON.stringify(obj, null, 4);
        return json.replace(/(".*?":|{|}|\[|\]|null|true|false|\d+)/g, match => {
            if (/^".*?":/.test(match)) return `<span class="json-key">${match}</span>`;
            if (/^".*?"$/.test(match)) return `<span class="json-string">${match}</span>`;
            if (/^-?\d+$/.test(match)) return `<span class="json-number">${match}</span>`;
            if (/^(true|false)$/.test(match)) return `<span class="json-boolean">${match}</span>`;
            if (match === 'null') return `<span class="json-null">${match}</span>`;
            return match;
        });
    };

    // Function to check server status
    const checkServer = async (address) => {
        if (!address) {
            showError('Please enter a valid server address');
            return;
        }

        const [host, port] = address.split(':');
        const edition = editionSelect.value;

        showLoading();

        // Önceki API Usage bölümünü temizle
        const existingApiUsage = resultContainer.querySelector('.api-usage');
        if (existingApiUsage) {
            existingApiUsage.remove();
        }

        try {
            // Yerel sunucuya istek at
            const response = await fetch(`/v1/status/${edition}/${encodeURIComponent(host)}${port ? `?port=${port}` : ''}`);
            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to check server status');
            }

            hideLoading();
            showResult(data);

            // API kullanım örneklerini göster
            const apiUsageContainer = document.createElement('div');
            apiUsageContainer.className = 'api-usage';
            
            // Örnek yanıt için basitleştirilmiş veri
            const sampleResponse = {
                status: data.status,
                ip: data.ip,
                port: data.port,
                hostname: data.hostname || data.host,
                version: data.version,
                players: {
                    online: data.players?.online || 0,
                    max: data.players?.max || 0
                },
                motd: data.motd,
                latency: data.latency,
                edition: edition
            };

            // API endpoint URL'sini göster (production URL)
            const endpointUrl = port ? 
                `https://api.raikou.me/v1/status/${edition}/${host}?port=${port}` :
                `https://api.raikou.me/v1/status/${edition}/${host}`;

            apiUsageContainer.innerHTML = `
                <h3>
                    API Usage
                    <span class="collapse-btn">
                        <i class="fas fa-chevron-up"></i>
                    </span>
                </h3>
                <div class="api-endpoint">
                    <span class="http-method">GET</span>
                    <span class="endpoint-url">${endpointUrl}</span>
                </div>
                <div class="code-block">
                    <pre><code>${formatJSON(sampleResponse)}</code></pre>
                </div>
            `;

            // API kullanım örneklerini result container'ın altına ekle
            resultContainer.appendChild(apiUsageContainer);

            // Collapse button functionality
            const collapseBtn = apiUsageContainer.querySelector('.collapse-btn');
            const codeBlock = apiUsageContainer.querySelector('.code-block');
            collapseBtn.addEventListener('click', () => {
                const icon = collapseBtn.querySelector('i');
                if (codeBlock.style.display === 'none') {
                    codeBlock.style.display = 'block';
                    icon.className = 'fas fa-chevron-up';
                } else {
                    codeBlock.style.display = 'none';
                    icon.className = 'fas fa-chevron-down';
                }
            });
        } catch (error) {
            hideLoading();
            showError(error.message);
            console.error('Error:', error);
        }
    };

    // Event listeners
    checkButton.addEventListener('click', () => {
        checkServer(serverInput.value.trim());
    });

    serverInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            checkServer(serverInput.value.trim());
        }
    });

    // Handle server card clicks
    serverCards.forEach(card => {
        card.addEventListener('click', () => {
            const address = card.querySelector('.server-address').textContent;
            serverInput.value = address;
            editionSelect.value = card.querySelector('.server-type').classList.contains('java') ? 'java' : 'bedrock';
            checkServer(address);
        });
    });
}); 
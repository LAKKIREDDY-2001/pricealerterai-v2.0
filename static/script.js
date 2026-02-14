// Dashboard JavaScript - Main app functionality with celebration
let trackers = [];
let currentFilter = 'all';
let currentTracker = null;
let celebrationTracker = null;
let appInitialized = false;
let currentUser = null;
let currentTrendPeriod = '7d';
const MAX_HISTORY_POINTS = 240;
const livePeriodByTracker = {};

// Backend API configuration
const getApiBaseUrl = () => {
    const currentUrl = window.location.origin;
    if (currentUrl.includes('localhost') || currentUrl.includes('127.0.0.1')) {
        return currentUrl;
    }
    return 'http://localhost:8081';
};
const API_BASE_URL = getApiBaseUrl();

// Celebration Configuration
const celebrationColors = [
    '#ff6b6b', '#feca57', '#48dbfb', '#ff9ff3', 
    '#54a0ff', '#5f27cd', '#00d2d3', '#ff9f0a'
];

function normalizeHistory(history) {
    if (!Array.isArray(history)) return [];
    return history
        .map(point => ({
            ts: Number(point.ts || Date.now()),
            price: Number(point.price)
        }))
        .filter(point => Number.isFinite(point.price))
        .sort((a, b) => a.ts - b.ts);
}

function addPriceHistoryPoint(tracker, price) {
    if (!tracker) return;
    tracker.priceHistory = normalizeHistory(tracker.priceHistory);
    const now = Date.now();
    const numericPrice = Number(price);
    if (!Number.isFinite(numericPrice)) return;

    const lastPoint = tracker.priceHistory[tracker.priceHistory.length - 1];
    if (lastPoint && Math.abs(lastPoint.price - numericPrice) < 0.0001 && now - lastPoint.ts < 30000) {
        return;
    }

    tracker.priceHistory.push({ ts: now, price: numericPrice });
    if (tracker.priceHistory.length > MAX_HISTORY_POINTS) {
        tracker.priceHistory = tracker.priceHistory.slice(-MAX_HISTORY_POINTS);
    }
}

function mergeTrackersWithLocalHistory(serverTrackers) {
    const cachedTrackers = JSON.parse(localStorage.getItem('trackers') || '[]');
    const cachedById = new Map(cachedTrackers.map(t => [String(t.id), t]));

    return serverTrackers.map(tracker => {
        const cached = cachedById.get(String(tracker.id));
        if (cached && cached.priceHistory) {
            tracker.priceHistory = normalizeHistory(cached.priceHistory);
        }
        addPriceHistoryPoint(tracker, tracker.currentPrice);
        return tracker;
    });
}

function buildSparklineSvg(history) {
    const points = normalizeHistory(history);
    if (points.length < 2) {
        return '<span class="sparkline-empty">Waiting for live data...</span>';
    }

    const width = 240;
    const height = 56;
    const padding = 6;
    const minPrice = Math.min(...points.map(p => p.price));
    const maxPrice = Math.max(...points.map(p => p.price));
    const priceRange = maxPrice - minPrice || 1;
    const stepX = (width - padding * 2) / (points.length - 1);

    const coords = points.map((point, index) => {
        const x = padding + index * stepX;
        const normalized = (point.price - minPrice) / priceRange;
        const y = height - padding - normalized * (height - padding * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');

    const strokeClass = points[points.length - 1].price <= points[0].price ? 'down' : 'up';
    return `<svg viewBox="0 0 ${width} ${height}" class="sparkline-svg" preserveAspectRatio="none"><polyline class="sparkline-line ${strokeClass}" points="${coords}" /></svg>`;
}

function getHistoryForPeriod(tracker, period) {
    const history = normalizeHistory(tracker?.priceHistory);
    if (history.length === 0) return [];

    const now = Date.now();
    let days = 7;
    if (period === '30d') days = 30;
    if (period === '90d') days = 90;
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    const filtered = history.filter(point => point.ts >= cutoff);
    return filtered.length > 1 ? filtered : history;
}

function getHistoryForLiveRange(tracker, rangeKey) {
    const history = normalizeHistory(tracker?.priceHistory);
    if (history.length === 0) return [];
    if (rangeKey === 'all') return history;

    const now = Date.now();
    let days = 30;
    if (rangeKey === '1d') days = 1;
    if (rangeKey === '1m') days = 30;
    if (rangeKey === '1y') days = 365;
    if (rangeKey === '5y') days = 365 * 5;
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    const filtered = history.filter(point => point.ts >= cutoff);
    return filtered.length > 1 ? filtered : history;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function deriveProductNameFromUrl(url) {
    if (!url) return 'Product';
    try {
        const parsed = new URL(url);
        const parts = parsed.pathname.split('/').filter(Boolean).map(part => decodeURIComponent(part));

        // Choose the best slug-like segment, not IDs/route tokens like p, dp, gp, product.
        const ignored = new Set(['p', 'dp', 'gp', 'product', 'products', 'itm']);
        let candidate = '';
        for (const part of parts) {
            const cleanedPart = part.replace(/\?.*$/, '').trim();
            if (!cleanedPart || ignored.has(cleanedPart.toLowerCase())) continue;
            const isLikelyId = /^[A-Za-z0-9_-]{6,}$/.test(cleanedPart) && !cleanedPart.includes('-');
            if (isLikelyId) continue;
            if (cleanedPart.length > candidate.length) candidate = cleanedPart;
        }

        candidate = candidate
            .replace(/[-_]+/g, ' ')
            .replace(/\b(online|best|prices?|india)\b/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        if (candidate.length >= 6) {
            return candidate.slice(0, 120);
        }
        return parsed.hostname.replace(/^www\./, '');
    } catch (error) {
        return 'Product';
    }
}

function getDisplayProductName(tracker) {
    const raw = (tracker?.productName || '').trim();
    const genericNames = ['product', 'add to your order', 'shop online', 'buy online'];
    if (raw && !genericNames.includes(raw.toLowerCase())) {
        return raw;
    }
    return deriveProductNameFromUrl(tracker?.url);
}

function getSiteSlugFromUrl(url) {
    const urlLower = String(url || '').toLowerCase();
    if (urlLower.includes('amazon')) return 'amazon';
    if (urlLower.includes('flipkart')) return 'flipkart';
    if (urlLower.includes('myntra')) return 'myntra';
    if (urlLower.includes('ajio')) return 'ajio';
    if (urlLower.includes('meesho')) return 'meesho';
    if (urlLower.includes('snapdeal')) return 'snapdeal';
    if (urlLower.includes('tatacliq')) return 'tatacliq';
    if (urlLower.includes('reliancedigital')) return 'reliancedigital';
    if (urlLower.includes('nykaa')) return 'nykaa';
    if (urlLower.includes('croma')) return 'croma';
    if (urlLower.includes('jiomart')) return 'jiomart';
    if (urlLower.includes('vijaysales')) return 'vijaysales';
    if (urlLower.includes('shopsy')) return 'shopsy';
    if (urlLower.includes('firstcry')) return 'firstcry';
    if (urlLower.includes('pepperfry')) return 'pepperfry';
    if (urlLower.includes('1mg') || urlLower.includes('tata1mg')) return 'tata1mg';
    if (urlLower.includes('bigbasket')) return 'bigbasket';
    return 'generic';
}

function getCompanyLogoImg(url, className = 'company-logo') {
    const slug = getSiteSlugFromUrl(url);
    return '<img class="' + className + '" src="/static/brand/sites/' + slug + '.png?v=4" alt="" onerror="this.onerror=null;this.src=\'/static/brand/sites/generic.png?v=4\';">';
}

function getCompanyLogoHtml(url) {
    return getCompanyLogoImg(url, 'company-logo');
}

function isCelebrationEnabled() {
    const settings = JSON.parse(localStorage.getItem('settings') || '{}');
    return settings.celebrationsEnabled !== false;
}

function setCelebrationEnabled(enabled) {
    const settings = JSON.parse(localStorage.getItem('settings') || '{}');
    settings.celebrationsEnabled = !!enabled;
    localStorage.setItem('settings', JSON.stringify(settings));
}

function enableLogoFallbacks() {
    const fallbackSrc = '/static/brand/sites/generic.png?v=4';
    document.querySelectorAll('.supported-site-logo').forEach((img) => {
        if (img.src && !img.src.includes('?v=')) {
            img.src = img.src + '?v=4';
        }
        img.onerror = () => {
            img.onerror = null;
            img.src = fallbackSrc;
        };
    });
}

// ==================== CELEBRATION FUNCTIONS ====================

function initCelebration() {
    // Close modal on outside click
    const modal = document.getElementById('celebration-modal');
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeCelebration();
            }
        });
    }
}

function showCelebration(tracker) {
    if (!isCelebrationEnabled()) return;

    const modal = document.getElementById('celebration-modal');
    const productNameEl = document.getElementById('celeb-product-name');
    const savingsEl = document.getElementById('celeb-savings');
    
    if (modal && tracker) {
        productNameEl.textContent = tracker.productName || 'Product';
        
        const saved = tracker.currentPrice - tracker.targetPrice;
        savingsEl.textContent = `You save ${tracker.currencySymbol || '$'}${Math.abs(saved).toFixed(2)}`;
        
        modal.classList.add('active');
        createConfetti();
        
        // Play sound effect (optional - browsers may block this)
        try {
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const oscillator = audioContext.createOscillator();
            const gainNode = audioContext.createGain();
            oscillator.connect(gainNode);
            gainNode.connect(audioContext.destination);
            oscillator.type = 'sine';
            oscillator.frequency.setValueAtTime(523.25, audioContext.currentTime); // C5
            oscillator.frequency.setValueAtTime(659.25, audioContext.currentTime + 0.1); // E5
            oscillator.frequency.setValueAtTime(783.99, audioContext.currentTime + 0.2); // G5
            gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3);
            oscillator.start(audioContext.currentTime);
            oscillator.stop(audioContext.currentTime + 0.3);
        } catch (e) {
            console.log('Audio playback blocked');
        }
    }
}

function closeCelebration() {
    const modal = document.getElementById('celebration-modal');
    if (modal) {
        modal.classList.remove('active');
        // Clear confetti
        const container = document.getElementById('confetti-container');
        if (container) {
            container.innerHTML = '';
        }
    }
}

function createConfetti() {
    const container = document.getElementById('confetti-container');
    if (!container) return;
    
    container.innerHTML = '';
    
    for (let i = 0; i < 150; i++) {
        const confetti = document.createElement('div');
        confetti.className = 'confetti';
        confetti.style.left = Math.random() * 100 + '%';
        confetti.style.backgroundColor = celebrationColors[Math.floor(Math.random() * celebrationColors.length)];
        confetti.style.animationDelay = Math.random() * 2 + 's';
        confetti.style.animationDuration = (Math.random() * 2 + 2) + 's';
        confetti.style.setProperty('--confetti-color', celebrationColors[Math.floor(Math.random() * celebrationColors.length)]);
        container.appendChild(confetti);
    }
}

function buyNowFromCelebration() {
    if (celebrationTracker && celebrationTracker.url) {
        window.open(celebrationTracker.url, '_blank');
    }
}

function stopCelebrations() {
    setCelebrationEnabled(false);
    closeCelebration();
    showToast('success', 'Celebrations stopped. You can still track price updates.');
}

function checkPriceReached(tracker) {
    return tracker && tracker.currentPrice <= tracker.targetPrice;
}

// ==================== TILT EFFECT ====================

function initTilt() {
    const tiltRoots = document.querySelectorAll('.tilt-root');
    if (!tiltRoots.length) return;
    if (window.matchMedia('(hover: none)').matches) return;

    tiltRoots.forEach((root) => {
        let rect = null;
        const maxTilt = parseFloat(root.dataset.tilt || '8');

        const handleMove = (event) => {
            if (!rect) rect = root.getBoundingClientRect();
            const x = (event.clientX - rect.left) / rect.width;
            const y = (event.clientY - rect.top) / rect.height;
            const tiltX = (0.5 - y) * maxTilt;
            const tiltY = (x - 0.5) * maxTilt;
            root.classList.add('tilt-active');
            root.style.setProperty('--tilt-x', tiltX.toFixed(2) + 'deg');
            root.style.setProperty('--tilt-y', tiltY.toFixed(2) + 'deg');
        };

        const handleLeave = () => {
            root.classList.remove('tilt-active');
            root.style.setProperty('--tilt-x', '0deg');
            root.style.setProperty('--tilt-y', '0deg');
            rect = null;
        };

        root.addEventListener('mousemove', handleMove);
        root.addEventListener('mouseleave', handleLeave);
    });
}

// ==================== USER & NAVIGATION ====================

async function loadUserData() {
    try {
        const response = await fetch(API_BASE_URL + '/api/user');
        if (response.ok) {
            const user = await response.json();
            currentUser = user;
            if (user.username) {
                document.getElementById('user-greeting').textContent = 'Welcome, ' + user.username;
            }
        }
    } catch (error) {
        console.log('User not logged in');
    }
}

function setupNavigation() {
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
        item.addEventListener('click', () => {
            const view = item.dataset.view;
            switchView(view);
        });
    });
}

function switchView(viewName) {
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('active');
        if (item.dataset.view === viewName) {
            item.classList.add('active');
        }
    });
    document.querySelectorAll('.view').forEach(view => {
        view.classList.remove('active');
    });
    document.getElementById('view-' + viewName).classList.add('active');
}

// ==================== PRICE TRACKING ====================

async function handleFlow() {
    const urlInput = document.getElementById('urlInput');
    const priceStep = document.getElementById('priceStep');
    const mainBtn = document.getElementById('mainBtn');
    
    if (!urlInput) {
        showToast('error', 'URL input element not found');
        return;
    }
    
    let url = urlInput.value.trim();
    
    if (!url) {
        showToast('error', 'Please enter a URL');
        return;
    }
    
    if (!url.startsWith('http://') && !url.startsWith('https://') && !url.toLowerCase().startsWith('test://')) {
        if (url.startsWith('www.')) {
            url = 'https://' + url;
        } else if (url.includes('.')) {
            url = 'https://' + url;
        } else {
            showToast('error', 'Invalid URL format');
            return;
        }
        urlInput.value = url;
    }
    
    if (priceStep.style.display === 'none') {
        setLoadingState(true, 'Fetching price...');
        
        try {
            const response = await fetch(API_BASE_URL + '/get-price', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: url })
            });
            
            const data = await response.json();
            
            if (response.ok) {
                priceStep.style.display = 'block';
                priceStep.innerHTML = '<p><strong>Current Price: ' + (data.currency_symbol || '$') + data.price + '</strong></p>' +
                    '<input type="number" id="targetPrice" class="product-input" style="width: 150px;" placeholder="Set target price" value="' + (data.price * 0.9).toFixed(2) + '">';
                mainBtn.innerHTML = 'Create Tracker';
                setLoadingState(false);
                
                priceStep.dataset.productName = data.productName || 'Product';
                priceStep.dataset.currentPrice = data.price;
                priceStep.dataset.currency = data.currency;
                priceStep.dataset.currencySymbol = data.currency_symbol;
            } else {
                setLoadingState(false);
                showToast('error', data.error || 'Failed to fetch price');
            }
        } catch (error) {
            setLoadingState(false);
            showToast('error', 'Failed to connect to server');
        }
    } else {
        const targetPrice = document.getElementById('targetPrice').value;
        if (!targetPrice) {
            showToast('error', 'Please set a target price');
            return;
        }
        
        const currentPrice = parseFloat(priceStep.dataset.currentPrice || 0);
        const productName = priceStep.dataset.productName || 'Product';
        const currency = priceStep.dataset.currency || 'USD';
        const currencySymbol = priceStep.dataset.currencySymbol || '$';
        
        await createTracker(url, targetPrice, currentPrice, productName, currency, currencySymbol);
    }
}

function setLoadingState(loading, message) {
    const mainBtn = document.getElementById('mainBtn');
    if (!mainBtn) return;
    
    if (loading) {
        mainBtn.disabled = true;
        mainBtn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> ' + (message || 'Loading...');
    } else {
        mainBtn.disabled = false;
        mainBtn.innerHTML = 'Start AI Tracking';
    }
}

async function createTracker(url, targetPrice, currentPrice, productName, currency, currencySymbol) {
    const urlInput = document.getElementById('urlInput');
    const mainBtn = document.getElementById('mainBtn');
    const priceStep = document.getElementById('priceStep');
    
    setLoadingState(true, 'Creating tracker...');
    
    try {
        const response = await fetch(API_BASE_URL + '/api/trackers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                url: url,
                currentPrice: currentPrice,
                targetPrice: parseFloat(targetPrice),
                currency: currency,
                currencySymbol: currencySymbol,
                productName: productName
            })
        });
        
        if (!response.ok) {
            throw new Error('Failed to create tracker');
        }
        
        const responseData = await response.json();
        const newTracker = {
            id: responseData.id || Date.now(),
            url: url,
            productName: productName,
            currentPrice: currentPrice,
            targetPrice: parseFloat(targetPrice),
            currency: currency,
            currencySymbol: currencySymbol,
            createdAt: new Date().toISOString(),
            priceHistory: []
        };
        addPriceHistoryPoint(newTracker, currentPrice);
        
        trackers.push(newTracker);
        localStorage.setItem('trackers', JSON.stringify(trackers));
        
        setLoadingState(false);
        showToast('success', 'Tracker created successfully!');
        
        urlInput.value = '';
        priceStep.style.display = 'none';
        mainBtn.innerHTML = 'Start AI Tracking';
        
        renderTrackers();
        updateStats();
        switchView('my-trackers');
    } catch (error) {
        setLoadingState(false);
        showToast('error', error.message);
    }
}

// ==================== TRACKERS DISPLAY ====================

async function loadTrackers() {
    // Prefer server data when logged in, fallback to local cache.
    try {
        const response = await fetch(API_BASE_URL + '/api/trackers', {
            credentials: 'include'
        });
        if (response.ok) {
            trackers = mergeTrackersWithLocalHistory(await response.json());
            localStorage.setItem('trackers', JSON.stringify(trackers));
            renderTrackers();
            updateStats();
            return;
        }
    } catch (error) {
        console.warn('Could not load trackers from server, using local cache');
    }

    trackers = JSON.parse(localStorage.getItem('trackers') || '[]').map(tracker => {
        tracker.priceHistory = normalizeHistory(tracker.priceHistory);
        addPriceHistoryPoint(tracker, tracker.currentPrice);
        return tracker;
    });
    renderTrackers();
    updateStats();
}

function buildLiveTrackingChartSvg(tracker, rangeKey = 'all') {
    const history = getHistoryForLiveRange(tracker, rangeKey);
    const pointsSource = history.length > 1
        ? history
        : [
            { ts: Date.now() - 120000, price: tracker.currentPrice || 0 },
            { ts: Date.now(), price: tracker.currentPrice || 0 }
        ];

    const width = 320;
    const height = 220;
    const padX = 14;
    const padTop = 20;
    const padBottom = 18;
    const plotW = width - padX * 2;
    const plotH = height - padTop - padBottom;

    const prices = pointsSource.map(p => Number(p.price) || 0);
    const target = Number(tracker.targetPrice) || prices[prices.length - 1] || 0;
    const min = Math.min(...prices, target);
    const max = Math.max(...prices, target);
    const range = max - min || 1;

    const points = pointsSource.map((point, index) => {
        const x = padX + (index / Math.max(pointsSource.length - 1, 1)) * plotW;
        const y = padTop + (1 - ((point.price - min) / range)) * plotH;
        return { x, y };
    });

    const path = points.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const area = `${padX},${height - padBottom} ${path} ${padX + plotW},${height - padBottom}`;
    const targetY = padTop + (1 - ((target - min) / range)) * plotH;
    const startPrice = prices[0] || 0;
    const endPrice = prices[prices.length - 1] || 0;
    const trendPct = startPrice > 0 ? ((endPrice - startPrice) / startPrice) * 100 : 0;
    const trendClass = trendPct > 0.2 ? 'up' : trendPct < -0.2 ? 'down' : 'flat';

    const maxLabel = (tracker.currencySymbol || '$') + max.toFixed(2);
    const midValue = min + range / 2;
    const midLabel = (tracker.currencySymbol || '$') + midValue.toFixed(2);
    const minLabel = (tracker.currencySymbol || '$') + min.toFixed(2);
    const midY = padTop + plotH / 2;

    return {
        svg: '<svg viewBox="0 0 ' + width + ' ' + height + '" class="lpt-chart-svg" preserveAspectRatio="none">' +
            '<line x1="' + padX + '" y1="' + padTop + '" x2="' + (padX + plotW) + '" y2="' + padTop + '" class="lpt-grid-line" />' +
            '<line x1="' + padX + '" y1="' + midY.toFixed(1) + '" x2="' + (padX + plotW) + '" y2="' + midY.toFixed(1) + '" class="lpt-grid-line" />' +
            '<line x1="' + padX + '" y1="' + (height - padBottom) + '" x2="' + (padX + plotW) + '" y2="' + (height - padBottom) + '" class="lpt-grid-line" />' +
            '<polyline points="' + area + '" class="lpt-area" />' +
            '<line x1="' + padX + '" y1="' + targetY.toFixed(1) + '" x2="' + (padX + plotW) + '" y2="' + targetY.toFixed(1) + '" class="lpt-target-line ' + trendClass + '" />' +
            '<polyline points="' + path + '" class="lpt-line" />' +
            '<text x="' + (padX + 2) + '" y="' + (padTop - 5) + '" class="lpt-y-label">' + maxLabel + '</text>' +
            '<text x="' + (padX + 2) + '" y="' + (midY - 5).toFixed(1) + '" class="lpt-y-label">' + midLabel + '</text>' +
            '<text x="' + (padX + 2) + '" y="' + (height - padBottom - 5) + '" class="lpt-y-label">' + minLabel + '</text>' +
            '</svg>',
        targetY,
        trendClass
    };
}

function renderLiveTrackingSection() {
    const container = document.getElementById('live-price-grid');
    if (!container) return;

    if (!trackers.length) {
        container.innerHTML = '<div class="live-empty">Create trackers to see live price cards.</div>';
        return;
    }

    container.innerHTML = trackers.map(tracker => {
        const current = Number(tracker.currentPrice || 0);
        const target = Number(tracker.targetPrice || current);
        const fullHistory = normalizeHistory(tracker.priceHistory);
        const firstTracked = fullHistory.length ? Number(fullHistory[0].price || current) : current;
        const growthPct = firstTracked > 0 ? ((current - firstTracked) / firstTracked) * 100 : 0;
        const growthAmount = current - firstTracked;
        const diffText = Math.abs(growthPct).toFixed(1) + '% (' + (tracker.currencySymbol || '$') + Math.abs(growthAmount).toFixed(2) + ') from first tracked (' + (tracker.currencySymbol || '$') + firstTracked.toFixed(2) + ')';
        const trendClass = growthPct > 0.2 ? 'up' : growthPct < -0.2 ? 'down' : 'flat';
        const trendIcon = trendClass === 'up' ? 'fa-caret-up' : trendClass === 'down' ? 'fa-caret-down' : 'fa-minus';
        const selectedRange = livePeriodByTracker[String(tracker.id)] || 'all';
        const chart = buildLiveTrackingChartSvg(tracker, selectedRange);
        const markerTop = Math.max(24, Math.min(194, chart.targetY));

        const displayName = getDisplayProductName(tracker);
        return '<article class="live-phone-card">' +
            '<div class="live-phone-shell">' +
            '<div class="live-topbar"><span class="live-clock">9:41</span><span class="live-brand">' + escapeHtml(displayName.slice(0, 18).toUpperCase()) + '</span><i class="fa fa-bell"></i></div>' +
            '<div class="live-card-body">' +
            '<div class="live-logo">' + getCompanyLogoImg(tracker.url, 'live-company-logo') + '</div>' +
            '<p class="live-title">Live Price</p>' +
            '<p class="live-product-name">' + escapeHtml(displayName) + '</p>' +
            '<div class="live-target-price">' + (tracker.currencySymbol || '$') + current.toFixed(2) + '</div>' +
            '<div class="live-diff ' + trendClass + '"><i class="fa ' + trendIcon + '"></i> ' + diffText + '</div>' +
            '<div class="live-chart-wrap">' + chart.svg + '<button class="live-marker ' + chart.trendClass + '" style="top:' + markerTop.toFixed(1) + 'px;"><i class="fa fa-arrows-v"></i></button></div>' +
            '<div class="live-periods">' +
            '<button class="live-period-btn ' + (selectedRange === '1d' ? 'active' : '') + '" onclick="setLiveGraphPeriod(' + tracker.id + ', \'1d\')">1d</button>' +
            '<button class="live-period-btn ' + (selectedRange === '1m' ? 'active' : '') + '" onclick="setLiveGraphPeriod(' + tracker.id + ', \'1m\')">1m</button>' +
            '<button class="live-period-btn ' + (selectedRange === '1y' ? 'active' : '') + '" onclick="setLiveGraphPeriod(' + tracker.id + ', \'1y\')">1y</button>' +
            '<button class="live-period-btn ' + (selectedRange === '5y' ? 'active' : '') + '" onclick="setLiveGraphPeriod(' + tracker.id + ', \'5y\')">5y</button>' +
            '<button class="live-period-btn ' + (selectedRange === 'all' ? 'active' : '') + '" onclick="setLiveGraphPeriod(' + tracker.id + ', \'all\')">All</button>' +
            '</div>' +
            '<button class="live-action-btn" onclick="viewTrends(' + tracker.id + ')">View Detailed Trend <i class="fa fa-check"></i></button>' +
            '</div></div></article>';
    }).join('');
}

function setLiveGraphPeriod(trackerId, rangeKey) {
    livePeriodByTracker[String(trackerId)] = rangeKey;
    renderLiveTrackingSection();
}

function renderTrackers() {
    const container = document.getElementById('trackers-list');
    if (trackers.length === 0) {
        container.innerHTML = '<div class="empty-state"><div class="empty-icon"><i class="fa fa-rocket"></i></div><h3>No trackers yet!</h3><p>Create your first price alert to start saving money</p><button class="action-btn" onclick="switchView(\'new-alert\')"><span class="btn-text">Create Tracker</span><span class="btn-icon"><i class="fa fa-plus"></i></span></button></div>';
        renderLiveTrackingSection();
        return;
    }
    
    let filteredTrackers = trackers;
    if (currentFilter !== 'all') {
        filteredTrackers = trackers.filter(t => {
            if (currentFilter === 'active') return t.currentPrice > t.targetPrice;
            if (currentFilter === 'reached') return t.currentPrice <= t.targetPrice;
            return true;
        });
    }
    
    container.innerHTML = filteredTrackers.map(tracker => {
        const status = tracker.currentPrice <= tracker.targetPrice ? 'reached' : 'active';
        const statusClass = status === 'reached' ? 'status-reached' : 'status-active';
        const statusText = status === 'reached' ? 'Target Reached!' : 'Active';
        
        const displayName = getDisplayProductName(tracker);
        return '<div class="tracker-card" data-id="' + tracker.id + '"><div class="tracker-header"><div class="tracker-info"><div class="tracker-logo">' + getCompanyLogoHtml(tracker.url) + '</div><h4 class="tracker-name">' + escapeHtml(displayName) + '</h4></div><div class="tracker-checkbox" onclick="event.stopPropagation(); toggleSelect(' + tracker.id + ')"><i class="fa fa-check" style="display: none;"></i></div></div><div class="tracker-url"><a href="' + tracker.url + '" target="_blank" rel="noopener noreferrer">' + tracker.url + '</a></div><div class="tracker-prices"><div class="price-info current"><span class="price-label">Current</span><span class="price-amount">' + (tracker.currencySymbol || '$') + tracker.currentPrice + '</span></div><div class="price-info target"><span class="price-label">Target</span><span class="price-amount">' + (tracker.currencySymbol || '$') + tracker.targetPrice + '</span></div><div class="price-status ' + statusClass + '">' + statusText + '</div></div><div class="tracker-sparkline"><div class="sparkline-header"><span>Live Trend</span><small>' + (tracker.priceHistory?.length || 0) + ' pts</small></div>' + buildSparklineSvg(tracker.priceHistory) + '</div><div class="tracker-actions"><button class="tracker-action" onclick="viewTrends(' + tracker.id + ')"><i class="fa fa-chart-line"></i> Trends</button><button class="tracker-action" onclick="refreshPrice(' + tracker.id + ')"><i class="fa fa-refresh"></i> Refresh</button><button class="tracker-action delete" onclick="deleteTracker(' + tracker.id + ')"><i class="fa fa-trash"></i></button></div>';
    }).join('');
    
    updateCounts();
    renderLiveTrackingSection();
}

function updateStats() {
    document.getElementById('sidebar-active-trackers').textContent = trackers.length;
    document.getElementById('sidebar-deals').textContent = trackers.filter(t => t.currentPrice <= t.targetPrice).length;
    document.getElementById('total-trackers').textContent = trackers.length;
    document.getElementById('active-deals').textContent = trackers.filter(t => t.currentPrice <= t.targetPrice).length;
    
    if (trackers.length > 0) {
        const totalSavings = trackers
            .filter(t => t.currentPrice <= t.targetPrice)
            .reduce((sum, t) => sum + (t.targetPrice - t.currentPrice), 0);
        const avgSavings = trackers.length > 0 ? Math.round((totalSavings / trackers.length) * 10) / 10 : 0;
        document.getElementById('avg-savings').textContent = avgSavings + '%';
    }
}

function updateCounts() {
    document.getElementById('count-all').textContent = trackers.length;
    document.getElementById('count-active').textContent = trackers.filter(t => t.currentPrice > t.targetPrice).length;
    document.getElementById('count-reached').textContent = trackers.filter(t => t.currentPrice <= t.targetPrice).length;
}

function setFilter(filter) {
    currentFilter = filter;
    document.querySelectorAll('.filter-tab').forEach(tab => {
        tab.classList.remove('active');
        if (tab.dataset.filter === filter) tab.classList.add('active');
    });
    renderTrackers();
}

function filterTrackers() {
    const search = document.getElementById('tracker-search').value.toLowerCase();
    const cards = document.querySelectorAll('.tracker-card');
    cards.forEach(card => {
        card.style.display = card.textContent.toLowerCase().includes(search) ? 'block' : 'none';
    });
}

function sortTrackers() {
    const sortBy = document.getElementById('sort-trackers').value;
    trackers.sort((a, b) => {
        if (sortBy === 'date') return new Date(b.createdAt) - new Date(a.createdAt);
        if (sortBy === 'name') return (a.productName || '').localeCompare(b.productName || '');
        if (sortBy === 'price') return a.currentPrice - b.currentPrice;
        return 0;
    });
    renderTrackers();
}

// ==================== PRICE REFRESH ====================

async function saveTrackerUpdateToServer(tracker) {
    if (!tracker || !tracker.id) return;
    try {
        await fetch(API_BASE_URL + '/api/trackers', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
                id: tracker.id,
                currentPrice: tracker.currentPrice,
                productName: tracker.productName,
                currency: tracker.currency || 'USD',
                currencySymbol: tracker.currencySymbol || '$'
            })
        });
    } catch (error) {
        console.warn('Failed to persist tracker update to server');
    }
}

async function refreshPrice(trackerId) {
    const tracker = trackers.find(t => t.id === trackerId);
    if (!tracker) return;
    
    const card = document.querySelector('.tracker-card[data-id="' + trackerId + '"]');
    const refreshBtn = card?.querySelector('.tracker-action[onclick*="refreshPrice"]');
    
    if (refreshBtn) {
        refreshBtn.disabled = true;
        refreshBtn.innerHTML = '<i class="fa fa-spinner fa-spin"></i>';
    }
    
    try {
        const response = await fetch(API_BASE_URL + '/get-price', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: tracker.url })
        });
        
        if (refreshBtn) {
            refreshBtn.disabled = false;
            refreshBtn.innerHTML = '<i class="fa fa-refresh"></i> Refresh';
        }
        
        const data = await response.json();
        
        if (response.ok) {
            const oldPrice = tracker.currentPrice;
            tracker.currentPrice = data.price;
            tracker.productName = data.productName || tracker.productName;
            tracker.currency = data.currency || tracker.currency;
            tracker.currencySymbol = data.currency_symbol || tracker.currencySymbol;
            addPriceHistoryPoint(tracker, tracker.currentPrice);
            
            // Check if target just reached
            if (checkPriceReached(tracker) && oldPrice > tracker.targetPrice) {
                celebrationTracker = tracker;
                setTimeout(() => {
                    showCelebration(tracker);
                }, 500);
            }
            
            localStorage.setItem('trackers', JSON.stringify(trackers));
            await saveTrackerUpdateToServer(tracker);
            showToast('success', 'Price updated: ' + (data.currency_symbol || '$') + data.price);
            renderTrackers();
            updateStats();
            if (currentTracker && String(currentTracker.id) === String(tracker.id)) {
                currentTracker = tracker;
                generateChart(tracker);
            }
        } else {
            showToast('error', data.error || 'Failed to refresh price');
        }
    } catch (error) {
        if (refreshBtn) {
            refreshBtn.disabled = false;
            refreshBtn.innerHTML = '<i class="fa fa-refresh"></i> Refresh';
        }
        showToast('error', 'Failed to connect to server');
    }
}

async function deleteTracker(trackerId) {
    if (!confirm('Are you sure you want to delete this tracker?')) return;
    try {
        await fetch(API_BASE_URL + '/api/trackers', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ id: trackerId })
        });
    } catch (error) {
        console.warn('Failed to delete tracker on server');
    }
    trackers = trackers.filter(t => t.id !== trackerId);
    localStorage.setItem('trackers', JSON.stringify(trackers));
    renderTrackers();
    updateStats();
    showToast('success', 'Tracker deleted');
}

function toggleSelect(trackerId) {
    const checkbox = document.querySelector('.tracker-card[data-id="' + trackerId + '"] .tracker-checkbox');
    checkbox.classList.toggle('checked');
    const icon = checkbox.querySelector('i');
    icon.style.display = checkbox.classList.contains('checked') ? 'block' : 'none';
}

// ==================== PRICE TRENDS ====================

function viewTrends(trackerId) {
    const tracker = trackers.find(t => t.id === trackerId);
    if (!tracker) return;
    addPriceHistoryPoint(tracker, tracker.currentPrice);
    currentTracker = tracker;
    switchView('price-trends');
    
    document.querySelector('.product-details h3').textContent = tracker.productName || 'Product';
    document.querySelector('.product-details p').textContent = tracker.url;
    document.getElementById('original-price').textContent = (tracker.currencySymbol || '$') + tracker.currentPrice;
    document.getElementById('current-price').textContent = (tracker.currencySymbol || '$') + tracker.currentPrice;
    
    const savings = tracker.currentPrice - tracker.targetPrice;
    document.getElementById('savings-amount').textContent = (tracker.currencySymbol || '$') + savings.toFixed(2);
    
    generateChart(tracker, currentTrendPeriod);
    
    const prediction = tracker.currentPrice <= tracker.targetPrice ? 'Price is at or below your target!' : 'Price may drop further';
    document.getElementById('prediction-text').textContent = prediction;
    document.getElementById('confidence').textContent = '85%';
}

function generateChart(tracker, period = currentTrendPeriod) {
    const chartContainer = document.querySelector('.chart-main');
    const history = getHistoryForPeriod(tracker, period);
    const usableHistory = history.length > 1 ? history : [{ ts: Date.now() - 60000, price: tracker.currentPrice }, { ts: Date.now(), price: tracker.currentPrice }];
    const prices = usableHistory.map(point => point.price);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const priceRange = maxPrice - minPrice || 1;

    const width = 920;
    const height = 250;
    const padTop = 24;
    const padBottom = 34;
    const padX = 24;
    const plotWidth = width - padX * 2;
    const plotHeight = height - padTop - padBottom;
    const count = usableHistory.length;

    const points = usableHistory.map((point, index) => {
        const x = padX + (index / Math.max(count - 1, 1)) * plotWidth;
        const y = padTop + (1 - (point.price - minPrice) / priceRange) * plotHeight;
        return { x, y, price: point.price };
    });

    const linePoints = points.map(point => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ');
    const areaPoints = `${padX},${height - padBottom} ${linePoints} ${padX + plotWidth},${height - padBottom}`;
    const trendClass = prices[prices.length - 1] <= prices[0] ? 'down' : 'up';

    const startLabel = new Date(usableHistory[0].ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const endLabel = new Date(usableHistory[usableHistory.length - 1].ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    const midValue = minPrice + priceRange / 2;
    chartContainer.innerHTML = '<svg viewBox="0 0 ' + width + ' ' + height + '" class="trend-svg" preserveAspectRatio="none">' +
        '<line x1="' + padX + '" y1="' + (height - padBottom) + '" x2="' + (padX + plotWidth) + '" y2="' + (height - padBottom) + '" class="trend-axis" />' +
        '<line x1="' + padX + '" y1="' + padTop + '" x2="' + padX + '" y2="' + (height - padBottom) + '" class="trend-axis" />' +
        '<line x1="' + padX + '" y1="' + (padTop + plotHeight / 2).toFixed(1) + '" x2="' + (padX + plotWidth) + '" y2="' + (padTop + plotHeight / 2).toFixed(1) + '" class="trend-grid" />' +
        '<polyline points="' + areaPoints + '" class="trend-area ' + trendClass + '" />' +
        '<polyline points="' + linePoints + '" class="trend-line ' + trendClass + '" />' +
        '<circle cx="' + points[points.length - 1].x.toFixed(2) + '" cy="' + points[points.length - 1].y.toFixed(2) + '" r="4" class="trend-last-point" />' +
        '<text x="' + (padX + 4) + '" y="' + (padTop - 6) + '" class="trend-y-label">' + (tracker.currencySymbol || '$') + maxPrice.toFixed(2) + '</text>' +
        '<text x="' + (padX + 4) + '" y="' + (padTop + plotHeight / 2 - 6).toFixed(1) + '" class="trend-y-label">' + (tracker.currencySymbol || '$') + midValue.toFixed(2) + '</text>' +
        '<text x="' + (padX + 4) + '" y="' + (height - padBottom - 6) + '" class="trend-y-label">' + (tracker.currencySymbol || '$') + minPrice.toFixed(2) + '</text>' +
        '<text x="' + padX + '" y="' + (height - 10) + '" class="trend-label">' + startLabel + '</text>' +
        '<text x="' + (padX + plotWidth - 64) + '" y="' + (height - 10) + '" class="trend-label">' + endLabel + '</text>' +
        '</svg>';

    document.getElementById('trend-lowest').textContent = (tracker.currencySymbol || '$') + minPrice.toFixed(2);
    document.getElementById('trend-highest').textContent = (tracker.currencySymbol || '$') + maxPrice.toFixed(2);
    document.getElementById('trend-since').textContent = new Date(tracker.createdAt).toLocaleDateString();
    document.getElementById('buy-now-btn').style.display = tracker.currentPrice <= tracker.targetPrice ? 'flex' : 'none';
    document.getElementById('buy-now-btn').onclick = () => window.open(tracker.url, '_blank');
}

function setTimePeriod(period) {
    currentTrendPeriod = period;
    document.querySelectorAll('.time-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.textContent.toLowerCase().includes(period.replace('d', ''))) btn.classList.add('active');
    });
    if (currentTracker) generateChart(currentTracker, period);
}

// ==================== TOAST NOTIFICATIONS ====================

function showToast(type, message) {
    if (typeof type === 'string' && typeof message === 'undefined') {
        message = type;
        type = 'success';
    }
    
    const existingToast = document.querySelector('.toast-notification');
    if (existingToast) {
        existingToast.remove();
    }
    
    const toast = document.createElement('div');
    toast.className = 'toast-notification';
    toast.innerHTML = `
        <div class="toast-icon ${type}">
            <i class="fa fa-${type === 'success' ? 'check' : 'times'}"></i>
        </div>
        <div class="toast-content">
            <strong>${type === 'success' ? 'Success!' : 'Error!'}</strong>
            <span>${message}</span>
        </div>
    `;
    
    // Add styles if not exists
    if (!document.getElementById('toast-styles')) {
        const styles = document.createElement('style');
        styles.id = 'toast-styles';
        styles.textContent = `
            .toast-notification {
                position: fixed;
                top: 24px;
                right: 24px;
                background: #1d1d1f;
                color: white;
                padding: 16px 24px;
                border-radius: 14px;
                display: flex;
                align-items: center;
                gap: 16px;
                box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
                transform: translateX(120%);
                transition: transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
                z-index: 1000;
            }
            .toast-notification.active { transform: translateX(0); }
            .toast-icon {
                width: 44px;
                height: 44px;
                border-radius: 12px;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 20px;
            }
            .toast-icon.success { background: linear-gradient(135deg, #11998e, #38ef7d); }
            .toast-icon.error { background: linear-gradient(135deg, #cb2d3e, #ef473a); }
            .toast-content { display: flex; flex-direction: column; }
            .toast-content strong { margin-bottom: 2px; }
            .toast-content span { font-size: 0.9rem; opacity: 0.9; }
        `;
        document.head.appendChild(styles);
    }
    
    document.body.appendChild(toast);
    
    setTimeout(() => {
        toast.classList.add('active');
    }, 10);
    
    setTimeout(() => {
        toast.classList.remove('active');
        setTimeout(() => {
            toast.remove();
        }, 400);
    }, 4000);
}

// ==================== SETTINGS ====================

function saveSettings() {
    const existingSettings = JSON.parse(localStorage.getItem('settings') || '{}');
    localStorage.setItem('settings', JSON.stringify({
        pushNotifications: document.getElementById('push-notifications').checked,
        emailAlerts: document.getElementById('email-alerts').checked,
        darkMode: document.getElementById('dark-mode').checked,
        compactView: document.getElementById('compact-view').checked,
        autoRefreshEnabled: document.getElementById('auto-refresh-enabled')?.checked ?? true,
        celebrationsEnabled: existingSettings.celebrationsEnabled !== false,
        refreshInterval: document.getElementById('refresh-interval').value,
        autoDelete: document.getElementById('auto-delete').value,
        dropPercentage: document.getElementById('drop-percentage').value
    }));
    showToast('success', 'Settings saved');
}

function saveCurrencyPreference() {
    localStorage.setItem('currency', document.getElementById('currency-select').value);
    showToast('success', 'Currency preference saved');
}

function toggleTheme() {
    document.body.classList.toggle('dark-mode');
    saveSettings();
}

function loadSettings() {
    const settings = JSON.parse(localStorage.getItem('settings') || '{}');
    if (settings.pushNotifications !== undefined) document.getElementById('push-notifications').checked = settings.pushNotifications;
    if (settings.emailAlerts !== undefined) document.getElementById('email-alerts').checked = settings.emailAlerts;
    if (settings.darkMode !== undefined) document.getElementById('dark-mode').checked = settings.darkMode;
    if (settings.compactView !== undefined) document.getElementById('compact-view').checked = settings.compactView;
    if (settings.autoRefreshEnabled !== undefined) document.getElementById('auto-refresh-enabled').checked = settings.autoRefreshEnabled;
    if (settings.refreshInterval !== undefined) document.getElementById('refresh-interval').value = settings.refreshInterval;
    if (settings.autoDelete !== undefined) document.getElementById('auto-delete').value = settings.autoDelete;
    if (settings.dropPercentage !== undefined) document.getElementById('drop-percentage').value = settings.dropPercentage;
    const currency = localStorage.getItem('currency');
    if (currency) document.getElementById('currency-select').value = currency;
}

// ==================== DATA IMPORT/EXPORT ====================

function exportData() {
    const data = JSON.stringify(trackers, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'price-tracker-backup.json';
    a.click();
    URL.revokeObjectURL(url);
    showToast('success', 'Data exported');
}

function importData(input) {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const imported = JSON.parse(e.target.result);
            if (Array.isArray(imported)) {
                trackers = imported.map(tracker => {
                    tracker.priceHistory = normalizeHistory(tracker.priceHistory);
                    addPriceHistoryPoint(tracker, tracker.currentPrice);
                    return tracker;
                });
                localStorage.setItem('trackers', JSON.stringify(trackers));
                renderTrackers();
                updateStats();
                showToast('success', 'Data imported successfully');
            }
        } catch (error) {
            showToast('error', 'Invalid file format');
        }
    };
    reader.readAsText(file);
}

function clearAllData() {
    if (!confirm('Are you sure you want to delete all trackers? This cannot be undone.')) return;
    trackers = [];
    localStorage.setItem('trackers', JSON.stringify(trackers));
    renderTrackers();
    updateStats();
    showToast('success', 'All data cleared');
}

function exportTrackers() { exportData(); }

function deleteSelected() {
    const selected = document.querySelectorAll('.tracker-checkbox.checked');
    if (selected.length === 0) {
        showToast('error', 'No trackers selected');
        return;
    }
    if (!confirm('Delete ' + selected.length + ' tracker(s)?')) return;
    selected.forEach(checkbox => {
        const card = checkbox.closest('.tracker-card');
        const id = parseInt(card.dataset.id);
        trackers = trackers.filter(t => t.id !== id);
    });
    localStorage.setItem('trackers', JSON.stringify(trackers));
    renderTrackers();
    updateStats();
    document.getElementById('bulk-actions').style.display = 'none';
    showToast('success', 'Selected trackers deleted');
}

// ==================== MODALS ====================

function connectTelegram() {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'telegram-modal';
    modal.innerHTML = `
        <div class="modal">
            <div class="modal-header">
                <h3><i class="fa fa-telegram"></i> Connect Telegram</h3>
                <button class="modal-close" onclick="closeModal('telegram-modal')">&times;</button>
            </div>
            <div class="modal-body">
                <div class="modal-icon telegram-icon">
                    <i class="fa fa-telegram"></i>
                </div>
                <p>Get instant price drop alerts on Telegram!</p>
                <button class="action-btn" onclick="window.open('https://t.me/AI_Price_Alert_Bot', '_blank')">
                    <i class="fa fa-external-link"></i> Open Telegram Bot
                </button>
            </div>
    `;
    document.body.appendChild(modal);
    setTimeout(() => modal.classList.add('active'), 10);
}

function connectWhatsApp() {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'whatsapp-modal';
    modal.innerHTML = `
        <div class="modal">
            <div class="modal-header">
                <h3><i class="fa fa-whatsapp"></i> Connect WhatsApp</h3>
                <button class="modal-close" onclick="closeModal('whatsapp-modal')">&times;</button>
            </div>
            <div class="modal-body">
                <div class="modal-icon whatsapp-icon">
                    <i class="fa fa-whatsapp"></i>
                </div>
                <p>Get price drop alerts on WhatsApp!</p>
                <input type="tel" id="whatsapp-number" class="product-input" placeholder="+1234567890" style="width: 100%; margin-bottom: 12px;">
                <button class="action-btn" onclick="saveWhatsAppNumber()">
                    <i class="fa fa-check"></i> Connect
                </button>
            </div>
    `;
    document.body.appendChild(modal);
    setTimeout(() => modal.classList.add('active'), 10);
}

function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.remove('active');
        setTimeout(() => modal.remove(), 300);
    }
}

function saveWhatsAppNumber() {
    showToast('success', 'WhatsApp connected!');
    closeModal('whatsapp-modal');
}

async function initializeApp() {
    if (appInitialized) return;
    appInitialized = true;

    enableLogoFallbacks();
    loadSettings();
    await loadTrackers();
    setupNavigation();
    loadUserData();
    initTilt();
    initCelebration();
    mountAIAssistantWidget();
    startAutoRefresh();
    addManualRefreshButton();
}

// ==================== AUTO-REFRESH ALERTER ====================

let autoRefreshInterval = null;
let lastRefreshTime = null;
let isAutoRefreshing = false;

function startAutoRefresh() {
    const enabled = document.getElementById('auto-refresh-enabled')?.checked ?? true;
    if (!enabled) {
        stopAutoRefresh();
        return;
    }

    const intervalSeconds = 5;
    const intervalMs = intervalSeconds * 1000;
    
    // Clear any existing interval
    if (autoRefreshInterval) {
        clearInterval(autoRefreshInterval);
    }
    
    // Start new interval
    autoRefreshInterval = setInterval(() => {
        autoRefreshAllPrices({ silent: true });
    }, intervalMs);

    // Run one refresh immediately so users see live updates without waiting.
    autoRefreshAllPrices({ silent: true });
    
    // Update UI to show auto-refresh is active
    updateAutoRefreshUI(intervalSeconds);
    console.log(`Auto-refresh started: every ${intervalSeconds} seconds`);
}

function stopAutoRefresh() {
    if (autoRefreshInterval) {
        clearInterval(autoRefreshInterval);
        autoRefreshInterval = null;
    }
    console.log('Auto-refresh stopped');
}

async function autoRefreshAllPrices(options = {}) {
    const { silent = false } = options;
    if (trackers.length === 0 || isAutoRefreshing) return;
    
    console.log('Auto-refreshing all prices...');
    lastRefreshTime = new Date();
    isAutoRefreshing = true;
    
    let updatedCount = 0;
    try {
        for (const tracker of trackers) {
            try {
                const response = await fetch(API_BASE_URL + '/get-price', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url: tracker.url })
                });

                if (response.ok) {
                    const data = await response.json();
                    const oldPrice = tracker.currentPrice;
                    tracker.currentPrice = data.price;
                    tracker.productName = data.productName || tracker.productName;
                    tracker.currency = data.currency || tracker.currency;
                    tracker.currencySymbol = data.currency_symbol || tracker.currencySymbol;
                    addPriceHistoryPoint(tracker, tracker.currentPrice);

                    // Check if target just reached
                    if (checkPriceReached(tracker) && oldPrice > tracker.targetPrice) {
                        celebrationTracker = tracker;
                        showCelebration(tracker);
                    }
                    await saveTrackerUpdateToServer(tracker);
                    updatedCount++;
                }
            } catch (error) {
                console.error(`Failed to refresh price for ${tracker.url}:`, error);
            }
        }
        
        // Save updated trackers
        localStorage.setItem('trackers', JSON.stringify(trackers));
        
        // Update UI
        renderTrackers();
        updateStats();
        if (currentTracker) {
            const updatedCurrent = trackers.find(t => String(t.id) === String(currentTracker.id));
            if (updatedCurrent) {
                currentTracker = updatedCurrent;
                generateChart(updatedCurrent);
            }
        }
        
        if (!silent && updatedCount > 0) {
            showToast('success', `Auto-refreshed ${updatedCount} tracker(s)`);
        }
    } finally {
        isAutoRefreshing = false;
    }
}

function updateAutoRefreshUI(intervalSeconds) {
    // Add auto-refresh indicator to the sidebar
    const sidebarStats = document.querySelector('.sidebar-stats');
    if (sidebarStats) {
        let refreshIndicator = document.getElementById('auto-refresh-indicator');
        if (!refreshIndicator) {
            refreshIndicator = document.createElement('div');
            refreshIndicator.id = 'auto-refresh-indicator';
            refreshIndicator.className = 'stat-item';
            refreshIndicator.innerHTML = `
                <span class="stat-value" id="refresh-timer"><i class="fa fa-sync fa-spin"></i></span>
                <span class="stat-label">Auto-refresh</span>
            `;
            sidebarStats.appendChild(refreshIndicator);
        }
    }
    
    // Update refresh timer display
    const refreshTimer = document.getElementById('refresh-timer');
    if (refreshTimer) {
        let secondsRemaining = intervalSeconds;
        refreshTimer.innerHTML = `<i class="fa fa-sync fa-spin"></i> ${formatTime(secondsRemaining)}`;
        
        // Update timer every second
        if (window.refreshTimerInterval) {
            clearInterval(window.refreshTimerInterval);
        }
        window.refreshTimerInterval = setInterval(() => {
            secondsRemaining--;
            if (secondsRemaining <= 0) {
                secondsRemaining = intervalSeconds;
            }
            const timerEl = document.getElementById('refresh-timer');
            if (timerEl) {
                timerEl.innerHTML = `<i class="fa fa-sync fa-spin"></i> ${formatTime(secondsRemaining)}`;
            }
        }, 1000);
    }
}

function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Add manual refresh button to the UI
function addManualRefreshButton() {
    const mainBtn = document.getElementById('mainBtn');
    if (mainBtn) {
        let refreshAllBtn = document.getElementById('refresh-all-btn');
        if (!refreshAllBtn) {
            refreshAllBtn = document.createElement('button');
            refreshAllBtn.id = 'refresh-all-btn';
            refreshAllBtn.className = 'action-btn secondary';
            refreshAllBtn.style.marginLeft = '10px';
            refreshAllBtn.innerHTML = '<i class="fa fa-refresh"></i> Refresh All';
            refreshAllBtn.onclick = () => {
                refreshAllBtn.disabled = true;
                refreshAllBtn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> Refreshing...';
                autoRefreshAllPrices().then(() => {
                    refreshAllBtn.disabled = false;
                    refreshAllBtn.innerHTML = '<i class="fa fa-refresh"></i> Refresh All';
                });
            };
            // Insert after main button
            mainBtn.parentNode.insertBefore(refreshAllBtn, mainBtn.nextSibling);
        }
    }
}

// Start app on page load
document.addEventListener('DOMContentLoaded', initializeApp);

// Stop auto-refresh when leaving the page
window.addEventListener('beforeunload', () => {
    stopAutoRefresh();
});

// ==================== NEW SETTINGS FUNCTIONS ====================

function toggleAutoRefresh() {
    const enabled = document.getElementById('auto-refresh-enabled').checked;
    saveSettings();
    if (enabled) {
        startAutoRefresh();
        showToast('success', 'Auto-refresh enabled');
    } else {
        stopAutoRefresh();
        showToast('success', 'Auto-refresh disabled');
    }
}

function restartAutoRefresh() {
    if (document.getElementById('auto-refresh-enabled')?.checked) {
        startAutoRefresh();
    }
}

function requestNotificationPermission() {
    if (!('Notification' in window)) {
        showToast('error', 'This browser does not support desktop notifications');
        return;
    }
    
    if (Notification.permission === 'granted') {
        showToast('success', 'Desktop notifications already enabled');
    } else if (Notification.permission !== 'denied') {
        Notification.requestPermission().then(permission => {
            if (permission === 'granted') {
                showToast('success', 'Desktop notifications enabled');
                new Notification('AI Price Alert', {
                    body: 'Notifications enabled successfully!',
                    icon: '🔔'
                });
            } else {
                showToast('error', 'Desktop notifications denied');
            }
        });
    }
}

function showApiKey() {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'api-modal';
    modal.innerHTML = `
        <div class="modal">
            <div class="modal-header">
                <h3><i class="fa fa-key"></i> API Access</h3>
                <button class="modal-close" onclick="closeModal('api-modal')">&times;</button>
            </div>
            <div class="modal-body">
                <p>Use this API key for custom integrations:</p>
                <div class="api-key-display">
                    <code id="api-key">AI_PRICE_ALERT_API_KEY_${Date.now()}_${Math.random().toString(36).substr(2, 9)}</code>
                    <button class="btn-secondary" onclick="copyApiKey()">
                        <i class="fa fa-copy"></i> Copy
                    </button>
                </div>
                <p class="api-docs-link">
                    <a href="#" target="_blank">View API Documentation</a>
                </p>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    setTimeout(() => modal.classList.add('active'), 10);
}

function copyApiKey() {
    const apiKey = document.getElementById('api-key').textContent;
    navigator.clipboard.writeText(apiKey).then(() => {
        showToast('success', 'API key copied to clipboard');
    }).catch(() => {
        showToast('error', 'Failed to copy API key');
    });
}

function showFeedbackModal() {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'feedback-modal';
    modal.innerHTML = `
        <div class="modal">
            <div class="modal-header">
                <h3><i class="fa fa-comment"></i> Send Feedback</h3>
                <button class="modal-close" onclick="closeModal('feedback-modal')">&times;</button>
            </div>
            <div class="modal-body">
                <p>We'd love to hear your thoughts!</p>
                <div class="form-group">
                    <label>Feedback Type</label>
                    <select id="feedback-type" class="product-input">
                        <option value="bug">Bug Report</option>
                        <option value="feature">Feature Request</option>
                        <option value="improvement">Improvement Idea</option>
                        <option value="other">Other</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Your Feedback</label>
                    <textarea id="feedback-message" class="product-input" rows="5" placeholder="Tell us what you think..."></textarea>
                </div>
                <button class="action-btn" id="feedback-submit-btn" onclick="submitFeedback()">
                    <i class="fa fa-paper-plane"></i> Submit Feedback
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    setTimeout(() => modal.classList.add('active'), 10);
}

async function submitFeedback(prefilledMessage) {
    const type = document.getElementById('feedback-type').value;
    const message = (prefilledMessage || document.getElementById('feedback-message').value || '').trim();
    const submitBtn = document.getElementById('feedback-submit-btn');
    
    if (!message) {
        showToast('error', 'Please enter your feedback');
        return;
    }

    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> Sending...';
    }

    try {
        const response = await fetch(API_BASE_URL + '/api/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type,
                message,
                source: 'dashboard_feedback',
                name: currentUser?.username || '',
                email: currentUser?.email || ''
            })
        });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || 'Unable to send feedback');
        }
        showToast('success', data.message || 'Feedback sent to mail');
        closeModal('feedback-modal');
    } catch (error) {
        // Direct fallback: open user's mail client with prefilled content.
        const subject = encodeURIComponent('AI Price Alert Feedback [' + type + ']');
        const body = encodeURIComponent(message + '\n\nSource: dashboard_feedback');
        window.location.href = 'mailto:pricealerterai@gmail.com?subject=' + subject + '&body=' + body;
        showToast('success', 'Opening mail app to send feedback directly');
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = '<i class="fa fa-paper-plane"></i> Submit Feedback';
        }
    }
}

function openAIAssistant() {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'ai-assistant-modal';
    modal.innerHTML = `
        <div class="modal ai-assistant-modal">
            <div class="modal-header">
                <h3><i class="fa fa-robot"></i> AI Support Assistant</h3>
                <button class="modal-close" onclick="closeModal('ai-assistant-modal')">&times;</button>
            </div>
            <div class="modal-body">
                <p>Enter your query. We will send it to feedback mail directly.</p>
                <div class="form-group">
                    <label>Your Query</label>
                    <textarea id="assistant-query" class="product-input" rows="5" placeholder="Type your query..."></textarea>
                </div>
                <div id="assistant-reply" class="assistant-reply" style="display:none;"></div>
                <button class="action-btn" onclick="sendAssistantQuery()">
                    <i class="fa fa-paper-plane"></i> Send Query
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    setTimeout(() => modal.classList.add('active'), 10);
}

function mountAIAssistantWidget() {
    if (document.getElementById('ai-assistant-fab')) return;
    const fab = document.createElement('button');
    fab.id = 'ai-assistant-fab';
    fab.className = 'ai-assistant-fab';
    fab.innerHTML = '<i class="fa fa-comments"></i><span class="ai-assistant-label">Chat Us</span>';
    fab.setAttribute('aria-label', 'Chat Us');
    fab.setAttribute('title', 'Chat Us');
    fab.onclick = openAIAssistant;
    document.body.appendChild(fab);
}

function buildAssistantReply(query) {
    const q = String(query || '').toLowerCase();
    if (q.includes('price') && q.includes('not')) {
        return 'Try Refresh All or wait 5 seconds for auto-refresh. Also verify product link is correct.';
    }
    if (q.includes('signup') || q.includes('sign up') || q.includes('login') || q.includes('sign in')) {
        return 'Use local app links: /signup and /login on localhost:8081. GitHub Pages is static only.';
    }
    if (q.includes('target') || q.includes('alert')) {
        return 'Set a lower target price than current price. You will be notified when current price reaches target.';
    }
    if (q.includes('graph') || q.includes('trend')) {
        return 'Open Live Price tab to view trend chart. Use 1d/1m/1y/5y/All filters for each product.';
    }
    if (q.includes('email') || q.includes('mail')) {
        return 'For direct emails, configure SMTP app password in email_config.json.';
    }
    return 'Thanks for your query. I can help with signup, alerts, trackers, live price graph, and settings.';
}

function sendAssistantQuery() {
    const queryEl = document.getElementById('assistant-query');
    const query = queryEl ? queryEl.value.trim() : '';
    const replyEl = document.getElementById('assistant-reply');
    if (!query) {
        showToast('error', 'Please enter your query');
        return;
    }
    if (replyEl) {
        replyEl.style.display = 'block';
        replyEl.innerHTML = '<strong>AI Reply:</strong> ' + escapeHtml(buildAssistantReply(query));
    }
    setTimeout(() => {
        closeModal('ai-assistant-modal');
        showFeedbackModal();
        setTimeout(() => {
            const typeEl = document.getElementById('feedback-type');
            const messageEl = document.getElementById('feedback-message');
            const payload = '[AI Query] ' + query + '\n\n[AI Reply] ' + buildAssistantReply(query);
            if (typeEl) typeEl.value = 'other';
            if (messageEl) messageEl.value = payload;
            submitFeedback(payload);
        }, 100);
    }, 1200);
}

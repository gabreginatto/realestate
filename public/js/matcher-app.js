/**
 * Property Matcher - Main Application
 * Human-in-the-loop matching interface for real estate listings
 */

// ===========================
// State Management
// ===========================
class MatcherState {
    constructor() {
        this.currentListing = null;
        this.candidates = [];
        this.sessionInfo = null;
        this.currentIndex = 0;
        this.taskQueue = [];
        this.theme = localStorage.getItem('matcher-theme') || 'light';
        this.preloadedNext = null;
        this.decisionStartTime = null;
        this.reviewer = this.getReviewer();
    }

    getReviewer() {
        let reviewer = localStorage.getItem('matcher-reviewer');
        if (!reviewer) {
            reviewer = prompt('Enter your name for reviewer tracking:') || 'anonymous';
            localStorage.setItem('matcher-reviewer', reviewer);
        }
        return reviewer;
    }

    setSession(sessionInfo) {
        this.sessionInfo = sessionInfo;
    }

    setCurrentListing(listing) {
        this.currentListing = listing;
        this.decisionStartTime = Date.now();
    }

    setCandidates(candidates) {
        this.candidates = candidates;
    }

    getTimeSpent() {
        if (!this.decisionStartTime) return 0;
        return Math.floor((Date.now() - this.decisionStartTime) / 1000);
    }
}

// ===========================
// API Client
// ===========================
class MatcherAPI {
    constructor(baseURL = '') {
        this.baseURL = (baseURL || '').replace(/\/+$/, '');
    }

    resolveEndpoint(endpoint) {
        if (/^https?:\/\//i.test(endpoint)) {
            return endpoint;
        }

        const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;

        if (!this.baseURL) {
            return normalizedEndpoint;
        }

        if (normalizedEndpoint.startsWith(this.baseURL)) {
            return normalizedEndpoint;
        }

        return `${this.baseURL}${normalizedEndpoint}`;
    }

    async request(endpoint, options = {}) {
        const url = this.resolveEndpoint(endpoint);
        const response = await fetch(url, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...options.headers
            }
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`API Error: ${error}`);
        }

        return response.json();
    }

    async getSession() {
        return this.request('/api/session');
    }

    async getNext() {
        return this.request('/api/next');
    }

    async getListing(id) {
        return this.request(`/api/listing/${id}`);
    }

    async getCandidates(vivaId) {
        return this.request(`/api/candidates/${vivaId}`);
    }

    async submitMatch(vivaCode, coelhoCode, timeSpent, reviewer, notes = '') {
        return this.request('/api/match', {
            method: 'POST',
            body: JSON.stringify({ viva_code: vivaCode, coelho_code: coelhoCode, time_spent_sec: timeSpent, reviewer, notes })
        });
    }

    async rejectCandidate(vivaCode, coelhoCode, reviewer, reason = '') {
        return this.request('/api/reject', {
            method: 'POST',
            body: JSON.stringify({ viva_code: vivaCode, coelho_code: coelhoCode, reviewer, reason })
        });
    }

    async skipListing(vivaCode, timeSpent, reviewer, reason = 'no_good_candidates') {
        return this.request('/api/skip', {
            method: 'POST',
            body: JSON.stringify({ viva_code: vivaCode, reason, time_spent_sec: timeSpent, reviewer })
        });
    }

    async undo(reviewer) {
        return this.request('/api/undo', {
            method: 'POST',
            body: JSON.stringify({ reviewer })
        });
    }

    async getProgress() {
        return this.request('/api/progress');
    }
}

// ===========================
// UI Controller
// ===========================
class MatcherUI {
    constructor() {
        this.elements = this.cacheElements();
        this.isMobile = window.matchMedia('(max-width: 768px)').matches;

        // Listen for viewport changes
        window.matchMedia('(max-width: 768px)').addEventListener('change', (e) => {
            this.isMobile = e.matches;
        });
    }

    cacheElements() {
        return {
            // Header
            progressBadge: document.getElementById('progress-badge'),
            matchedCount: document.getElementById('matched-count'),
            skippedCount: document.getElementById('skipped-count'),
            progressFill: document.getElementById('progress-fill'),
            themeToggle: document.getElementById('theme-toggle'),
            helpBtn: document.getElementById('help-btn'),
            undoBtn: document.getElementById('undo-btn'),

            // Viva Section
            vivaTitle: document.getElementById('viva-title'),
            vivaMosaic: document.getElementById('viva-mosaic'),
            vivaPrice: document.getElementById('viva-price'),
            vivaArea: document.getElementById('viva-area'),
            vivaBedrooms: document.getElementById('viva-bedrooms'),
            vivaSuites: document.getElementById('viva-suites'),
            vivaAddress: document.getElementById('viva-address'),
            vivaUrl: document.getElementById('viva-url'),

            // Candidates Section
            candidateCount: document.getElementById('candidate-count'),
            candidatesGrid: document.getElementById('candidates-grid'),
            noCandidates: document.getElementById('no-candidates'),
            skipBtn: document.getElementById('skip-btn'),

            // Navigation
            prevBtn: document.getElementById('prev-btn'),
            nextBtn: document.getElementById('next-btn'),
            currentIndex: document.getElementById('current-index'),
            totalCount: document.getElementById('total-count'),

            // Mobile Bottom Bar
            mobileSkipBtn: document.getElementById('mobile-skip-btn'),
            mobileUndoBtn: document.getElementById('mobile-undo-btn'),

            // Modals
            lightbox: document.getElementById('lightbox'),
            lightboxImage: document.getElementById('lightbox-image'),
            lightboxTitle: document.getElementById('lightbox-title'),
            lightboxCounter: document.getElementById('lightbox-counter'),
            lightboxPrev: document.getElementById('lightbox-prev'),
            lightboxNext: document.getElementById('lightbox-next'),
            helpModal: document.getElementById('help-modal'),

            // Toast & Loading
            toastContainer: document.getElementById('toast-container'),
            loadingOverlay: document.getElementById('loading-overlay')
        };
    }

    showLoading(show = true) {
        this.elements.loadingOverlay.style.display = show ? 'flex' : 'none';
    }

    showToast(message, type = 'info') {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        this.elements.toastContainer.appendChild(toast);

        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    updateSession(sessionInfo) {
        const { stats } = sessionInfo;

        const reviewed = stats.matched + stats.rejected + stats.skipped;
        const total = stats.total_viva_listings || 0;

        // Update progress badge with animation
        const newProgressText = `${reviewed}/${total}`;
        if (this.elements.progressBadge.textContent !== newProgressText) {
            this.elements.progressBadge.style.transform = 'scale(1.1)';
            setTimeout(() => {
                this.elements.progressBadge.style.transform = 'scale(1)';
            }, 150);
        }
        this.elements.progressBadge.textContent = newProgressText;

        // Update matched count with animation
        const newMatchedText = `✓ ${stats.matched}`;
        const matchedSpan = this.elements.matchedCount;
        if (matchedSpan.textContent !== newMatchedText) {
            matchedSpan.style.transform = 'scale(1.15)';
            setTimeout(() => {
                matchedSpan.style.transform = 'scale(1)';
            }, 200);
        }
        matchedSpan.innerHTML = `<span aria-hidden="true">✓</span> ${stats.matched}`;

        // Update skipped count
        this.elements.skippedCount.innerHTML = `<span aria-hidden="true">⊘</span> ${stats.skipped}`;

        // Update progress bar
        const progress = total > 0 ? (reviewed / total * 100) : 0;
        this.elements.progressFill.style.width = `${progress}%`;

        // Update ARIA attributes
        const progressBar = this.elements.progressFill.parentElement;
        if (progressBar) {
            progressBar.setAttribute('aria-valuenow', Math.round(progress));
        }
    }

    renderVivaListing(listing) {
        if (!listing) return;

        this.elements.vivaTitle.textContent = `Source #${listing.propertyCode}`;

        // Use mosaic path from backend if available
        const mosaicSrc = listing.mosaicPath || `/mosaics/vivaprimeimoveis/${listing.propertyCode}.png`;

        // Show loading state while image loads
        this.elements.vivaMosaic.style.opacity = '0.5';
        this.elements.vivaMosaic.onload = () => {
            this.elements.vivaMosaic.style.opacity = '1';
        };
        this.elements.vivaMosaic.src = mosaicSrc;
        this.elements.vivaMosaic.dataset.code = listing.propertyCode;
        this.elements.vivaMosaic.alt = `Property mosaic for listing ${listing.propertyCode}`;

        this.elements.vivaPrice.textContent = this.formatPrice(listing.price);
        this.elements.vivaArea.textContent = listing.area ? `${listing.area}m²` : '-';
        this.elements.vivaBedrooms.textContent = listing.bedrooms || '-';
        this.elements.vivaSuites.textContent = listing.suites || '-';
        this.elements.vivaAddress.textContent = listing.address || '-';

        if (listing.url) {
            this.elements.vivaUrl.href = listing.url;
            this.elements.vivaUrl.style.display = 'inline';
        } else {
            this.elements.vivaUrl.style.display = 'none';
        }
    }

    clearVivaListing() {
        this.elements.vivaTitle.textContent = 'All listings reviewed!';
        this.elements.vivaMosaic.src = '';
        this.elements.vivaMosaic.alt = 'No more listings';
        this.elements.vivaPrice.textContent = '-';
        this.elements.vivaArea.textContent = '-';
        this.elements.vivaBedrooms.textContent = '-';
        this.elements.vivaSuites.textContent = '-';
        this.elements.vivaAddress.textContent = '-';
        this.elements.vivaUrl.style.display = 'none';
    }

    renderCandidates(candidates) {
        this.elements.candidateCount.textContent = candidates.length;
        this.elements.candidatesGrid.innerHTML = '';

        if (candidates.length === 0) {
            this.elements.noCandidates.style.display = 'block';
            this.elements.candidatesGrid.style.display = 'none';
            return;
        }

        this.elements.noCandidates.style.display = 'none';
        this.elements.candidatesGrid.style.display = 'grid';

        candidates.forEach((candidate, index) => {
            const card = this.createCandidateCard(candidate, index + 1);
            this.elements.candidatesGrid.appendChild(card);
        });
    }

    createCandidateCard(candidate, rank) {
        const card = document.createElement('div');
        card.className = 'candidate-card';
        card.dataset.code = candidate.propertyCode;
        card.setAttribute('role', 'listitem');

        // Use delta values from backend if available, otherwise calculate
        const priceDelta = candidate.priceDelta !== undefined
            ? candidate.priceDelta
            : this.calculateDelta(candidate.priceViva, candidate.priceCoelho);
        const areaDelta = candidate.areaDelta !== undefined
            ? candidate.areaDelta
            : this.calculateDelta(candidate.areaViva, candidate.areaCoelho);

        // Use mosaic path from backend
        const mosaicSrc = candidate.mosaicPath || `/mosaics/coelhodafonseca/${candidate.propertyCode}.png`;

        // AI score badge color
        const aiScoreDisplay = candidate.aiScore
            ? `<div class="ai-score">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <span>AI Confidence</span>
                        <span style="font-weight: 700;">${(candidate.aiScore * 100).toFixed(0)}%</span>
                    </div>
                    <div class="score-bar">
                        <div class="score-fill" style="width: ${candidate.aiScore * 100}%"></div>
                    </div>
                </div>`
            : '';

        card.innerHTML = `
            <div class="candidate-header">
                <h3 class="candidate-id">Candidate #${candidate.propertyCode}</h3>
                <span class="candidate-rank">#${rank}</span>
            </div>

            <div class="candidate-content">
                <!-- Candidate Mosaic -->
                <div class="candidate-mosaic mosaic-wrapper">
                    <img src="${mosaicSrc}"
                         alt="Candidate property mosaic ${candidate.propertyCode}"
                         class="mosaic-image clickable"
                         data-code="${candidate.propertyCode}"
                         data-site="coelho"
                         loading="lazy"
                         style="opacity: 0.5; transition: opacity 0.3s ease;">
                    <div class="mosaic-overlay">Tap to zoom</div>
                </div>

                <!-- Candidate Metadata -->
                <div class="metadata-panel">
                    ${aiScoreDisplay}
                    <h3>Comparison</h3>
                    <div class="metadata-grid">
                        <div class="metadata-item">
                            <span class="label">Price</span>
                            <span class="value">${this.formatPrice(candidate.price)}</span>
                        </div>
                        <div class="metadata-item">
                            <span class="label">Diff</span>
                            <span class="value delta ${this.getDeltaClass(priceDelta)}">${this.formatDelta(priceDelta)}</span>
                        </div>
                        <div class="metadata-item">
                            <span class="label">Area</span>
                            <span class="value">${candidate.area ? candidate.area + 'm²' : '-'}</span>
                        </div>
                        <div class="metadata-item">
                            <span class="label">Diff</span>
                            <span class="value delta ${this.getDeltaClass(areaDelta)}">${this.formatDelta(areaDelta)}</span>
                        </div>
                        <div class="metadata-item">
                            <span class="label">Beds</span>
                            <span class="value">${candidate.bedrooms || '-'}</span>
                        </div>
                        <div class="metadata-item">
                            <span class="label">Suites</span>
                            <span class="value">${candidate.suites || '-'}</span>
                        </div>
                        ${candidate.url ? `
                            <div class="metadata-item full-width">
                                <span class="label">Link</span>
                                <a href="${candidate.url}" class="value link" target="_blank" rel="noopener">View listing →</a>
                            </div>
                        ` : ''}
                    </div>

                    <!-- Action button -->
                    <div class="candidate-actions">
                        <button class="btn btn-success btn-large match-btn"
                                data-coelho-code="${candidate.propertyCode}"
                                aria-label="Confirm match with candidate ${candidate.propertyCode}">
                            <span aria-hidden="true">✓</span> Match
                            <kbd style="margin-left: auto; opacity: 0.7; font-size: 0.75rem;">${rank}</kbd>
                        </button>
                    </div>
                </div>
            </div>
        `;

        // Handle image load
        const img = card.querySelector('.mosaic-image');
        img.onload = () => {
            img.style.opacity = '1';
        };

        return card;
    }

    formatPrice(price) {
        if (!price) return '-';
        // Parse Brazilian price format: R$ 4.900.000,00 -> 4900000
        let num;
        if (typeof price === 'string') {
            // Remove R$, spaces, periods (thousands separator), convert comma to period
            num = parseFloat(price.replace(/R\$\s*/g, '').replace(/\./g, '').replace(/,/g, '.'));
        } else {
            num = price;
        }
        if (isNaN(num)) return price;
        return new Intl.NumberFormat('pt-BR', {
            style: 'currency',
            currency: 'BRL',
            minimumFractionDigits: 0
        }).format(num);
    }

    calculateDelta(original, compared) {
        const orig = parseFloat(String(original || '0').replace(/[^0-9.]/g, ''));
        const comp = parseFloat(String(compared || '0').replace(/[^0-9.]/g, ''));
        if (orig === 0) return 0;
        return ((comp - orig) / orig * 100);
    }

    getDeltaClass(delta) {
        if (Math.abs(delta) < 2) return 'neutral';
        return delta > 0 ? 'positive' : 'negative';
    }

    formatDelta(delta) {
        if (delta === null || delta === undefined || isNaN(delta)) {
            return '0.0%';
        }
        const sign = delta > 0 ? '+' : '';
        return `${sign}${delta.toFixed(1)}%`;
    }

    showLightbox(imageSrc, title) {
        this.elements.lightboxImage.src = imageSrc;
        this.elements.lightboxTitle.textContent = title;
        this.elements.lightbox.style.display = 'flex';
    }

    hideLightbox() {
        this.elements.lightbox.style.display = 'none';
    }

    showHelp() {
        this.elements.helpModal.style.display = 'flex';
    }

    hideHelp() {
        this.elements.helpModal.style.display = 'none';
    }

    toggleTheme() {
        const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
        const newTheme = currentTheme === 'light' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', newTheme);
        localStorage.setItem('matcher-theme', newTheme);
        this.elements.themeToggle.textContent = newTheme === 'light' ? '🌙' : '☀️';
    }

    enableUndo(enabled = true) {
        this.elements.undoBtn.disabled = !enabled;
        // Also update mobile undo button
        if (this.elements.mobileUndoBtn) {
            this.elements.mobileUndoBtn.disabled = !enabled;
        }
    }

    // Haptic feedback for mobile (if supported)
    vibrate(pattern = 10) {
        if (this.isMobile && navigator.vibrate) {
            navigator.vibrate(pattern);
        }
    }
}

// ===========================
// Main Application
// ===========================
class MatcherApp {
    constructor() {
        this.state = new MatcherState();
        const globalBase = typeof window !== 'undefined'
            ? (window.__MATCHER_API_BASE__ ?? window.MATCHER_API_BASE ?? window.MATCHER_API_BASE_URL ?? '')
            : '';
        this.api = new MatcherAPI(globalBase);
        this.ui = new UI();

        this.init();
    }

    async init() {
        // Apply saved theme
        document.documentElement.setAttribute('data-theme', this.state.theme);
        this.ui.elements.themeToggle.textContent = this.state.theme === 'light' ? '🌙' : '☀️';

        // Setup event listeners
        this.setupEventListeners();

        // Load initial session
        await this.loadSession();
        await this.loadNextListing();
    }

    setupEventListeners() {
        // Header controls
        this.ui.elements.themeToggle.addEventListener('click', () => {
            this.ui.toggleTheme();
            this.ui.vibrate(5);
        });
        this.ui.elements.helpBtn.addEventListener('click', () => this.ui.showHelp());
        this.ui.elements.undoBtn.addEventListener('click', () => this.handleUndo());

        // Skip buttons (desktop and mobile)
        this.ui.elements.skipBtn.addEventListener('click', () => this.skipListing());
        if (this.ui.elements.mobileSkipBtn) {
            this.ui.elements.mobileSkipBtn.addEventListener('click', () => this.skipListing());
        }

        // Mobile undo button
        if (this.ui.elements.mobileUndoBtn) {
            this.ui.elements.mobileUndoBtn.addEventListener('click', () => this.handleUndo());
        }

        // Lightbox
        document.querySelector('.lightbox-close').addEventListener('click', () => this.ui.hideLightbox());
        this.ui.elements.lightbox.addEventListener('click', (e) => {
            if (e.target === this.ui.elements.lightbox) this.ui.hideLightbox();
        });

        // Mosaic clicks (delegate to grid)
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('mosaic-image') && e.target.classList.contains('clickable')) {
                const site = e.target.dataset.site;
                const code = e.target.dataset.code;
                const title = site === 'viva' ? `Source #${code}` : `Candidate #${code}`;
                this.ui.showLightbox(e.target.src, title);
                this.ui.vibrate(5);
            }

            if (e.target.classList.contains('match-btn')) {
                const coelhoCode = e.target.dataset.coelhoCode;
                this.confirmMatch(coelhoCode);
            }
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => this.handleKeyboard(e));

        // Prevent accidental navigation away
        window.addEventListener('beforeunload', (e) => {
            if (this.state.currentListing) {
                e.preventDefault();
                e.returnValue = '';
            }
        });

        // Handle help modal click outside
        this.ui.elements.helpModal.addEventListener('click', (e) => {
            if (e.target === this.ui.elements.helpModal) {
                this.ui.hideHelp();
            }
        });
    }

    async loadSession() {
        try {
            this.ui.showLoading(true);
            const sessionInfo = await this.api.getSession();
            this.state.setSession(sessionInfo);
            this.ui.updateSession(sessionInfo);
        } catch (error) {
            console.error('Failed to load session:', error);
            this.ui.showToast('Failed to load session', 'error');
        } finally {
            this.ui.showLoading(false);
        }
    }

    async loadNextListing() {
        try {
            this.ui.showLoading(true);

            // Get next listing from backend
            const response = await this.api.getNext();

            // Handle completion
            if (response.done || !response.viva_code) {
                this.ui.showToast('All listings reviewed!', 'success');
                this.state.setCurrentListing(null);
                this.state.setCandidates([]);
                this.ui.clearVivaListing();
                this.ui.renderCandidates([]);
                return;
            }

            // Extract viva listing data
            const { viva_code, viva, mosaic_path } = response;

            // Normalize viva listing for UI
            // Support both formats: detailedData.specs (old) and specs (new)
            const specs = viva.detailedData?.specs || viva.specs || {};
            const vivaListing = {
                propertyCode: viva_code,
                price: viva.price,
                area: specs.area_construida,
                bedrooms: specs.dormitorios,
                suites: specs.suites,
                address: viva.address,
                url: viva.url,
                mosaicPath: mosaic_path
            };

            // Fetch candidates for this listing
            const candidatesResponse = await this.api.getCandidates(viva_code);

            // Normalize candidates for UI (backend returns { candidates: [...] })
            const normalizedCandidates = (candidatesResponse?.candidates || []).map(item => {
                console.log('Processing candidate:', item.code, item);

                // Extract area and bedroom info from features string
                const features = item.candidate.features || '';
                const areaMatch = features.match(/(\d+)\s*m²\s*constru[ií]da/i);
                const bedsMatch = features.match(/(\d+)\s*dorm/i);
                const suitesMatch = features.match(/(\d+)\s*su[ií]te/i);

                const normalized = {
                    propertyCode: item.code,
                    price: item.candidate.price,
                    area: areaMatch ? parseFloat(areaMatch[1]) : null,
                    bedrooms: bedsMatch ? parseInt(bedsMatch[1]) : null,
                    suites: suitesMatch ? parseInt(suitesMatch[1]) : null,
                    url: item.candidate.url,
                    mosaicPath: item.mosaic_path,
                    aiScore: item.ai_score,
                    priceDelta: item.deltas?.price_delta_pct,
                    areaDelta: item.deltas?.area_delta_pct,
                    priceViva: item.deltas?.price_viva,
                    priceCoelho: item.deltas?.price_coelho,
                    areaViva: item.deltas?.area_viva,
                    areaCoelho: item.deltas?.area_coelho
                };

                console.log('Normalized candidate:', normalized);
                return normalized;
            });

            console.log('Total normalized candidates:', normalizedCandidates.length);

            this.state.setCurrentListing(vivaListing);
            this.state.setCandidates(normalizedCandidates);

            this.ui.renderVivaListing(vivaListing);
            this.ui.renderCandidates(normalizedCandidates);

            // Update session stats
            await this.loadSession();
        } catch (error) {
            console.error('Failed to load next listing:', error);
            this.ui.showToast('Failed to load listing', 'error');
        } finally {
            this.ui.showLoading(false);
        }
    }

    async confirmMatch(coelhoCode) {
        if (!this.state.currentListing) return;

        const vivaCode = this.state.currentListing.propertyCode;
        const timeSpent = this.state.getTimeSpent();
        const reviewer = this.state.reviewer;

        // Haptic feedback for match confirmation
        this.ui.vibrate([10, 50, 10]);

        try {
            this.ui.showLoading(true);
            await this.api.submitMatch(vivaCode, coelhoCode, timeSpent, reviewer);
            this.ui.showToast(`Match confirmed: #${vivaCode} ↔ #${coelhoCode}`, 'success');
            this.ui.enableUndo(true);
            await this.loadNextListing();
        } catch (error) {
            console.error('Failed to submit match:', error);
            this.ui.showToast('Failed to save match', 'error');
            this.ui.vibrate(100); // Error feedback
        } finally {
            this.ui.showLoading(false);
        }
    }

    async skipListing() {
        if (!this.state.currentListing) return;

        const vivaCode = this.state.currentListing.propertyCode;
        const timeSpent = this.state.getTimeSpent();
        const reviewer = this.state.reviewer;

        // Light haptic feedback for skip
        this.ui.vibrate(5);

        try {
            this.ui.showLoading(true);
            await this.api.skipListing(vivaCode, timeSpent, reviewer);
            this.ui.showToast(`Skipped #${vivaCode}`, 'info');
            this.ui.enableUndo(true);
            await this.loadNextListing();
        } catch (error) {
            console.error('Failed to skip listing:', error);
            this.ui.showToast('Failed to skip listing', 'error');
            this.ui.vibrate(100); // Error feedback
        } finally {
            this.ui.showLoading(false);
        }
    }

    async handleUndo() {
        const reviewer = this.state.reviewer;

        try {
            this.ui.showLoading(true);
            await this.api.undo(reviewer);
            this.ui.showToast('Undone last decision', 'info');
            this.ui.enableUndo(false);
            await this.loadNextListing();
        } catch (error) {
            console.error('Failed to undo:', error);
            this.ui.showToast('Failed to undo', 'error');
        } finally {
            this.ui.showLoading(false);
        }
    }

    handleKeyboard(e) {
        // Don't trigger if typing in input/textarea
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        // Escape - close modals
        if (e.key === 'Escape') {
            this.ui.hideLightbox();
            this.ui.hideHelp();
            return;
        }

        // ? - help
        if (e.key === '?') {
            this.ui.showHelp();
            return;
        }

        // U - undo
        if (e.key.toLowerCase() === 'u') {
            if (!this.ui.elements.undoBtn.disabled) {
                this.handleUndo();
            }
            return;
        }

        // S - skip
        if (e.key.toLowerCase() === 's') {
            this.skipListing();
            return;
        }

        // 1-9 - select candidate
        const num = parseInt(e.key);
        if (num >= 1 && num <= 9) {
            const candidates = this.state.candidates;
            if (num <= candidates.length) {
                const candidate = candidates[num - 1];
                this.confirmMatch(candidate.propertyCode);
            }
            return;
        }
    }

    // Export for HTML onclick handlers
    hideHelp() {
        this.ui.hideHelp();
    }
}

// ===========================
// Initialize App
// ===========================
const UI = MatcherUI; // Alias for consistency

if (typeof window !== 'undefined') {
    window.matcherApp = new MatcherApp();
}

export { MatcherAPI };

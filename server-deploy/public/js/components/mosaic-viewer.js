/**
 * Mosaic Viewer Component
 * Handles lightbox functionality for property mosaics
 *
 * Note: Currently integrated into matcher-app.js
 * This module can be extracted for reuse in other contexts
 */

export class MosaicViewer {
    constructor(lightboxElement) {
        this.lightbox = lightboxElement;
        this.imageElement = lightboxElement.querySelector('#lightbox-image');
        this.titleElement = lightboxElement.querySelector('#lightbox-title');
        this.counterElement = lightboxElement.querySelector('#lightbox-counter');
        this.prevBtn = lightboxElement.querySelector('#lightbox-prev');
        this.nextBtn = lightboxElement.querySelector('#lightbox-next');
        this.closeBtn = lightboxElement.querySelector('.lightbox-close');

        this.currentImages = [];
        this.currentIndex = 0;

        this.setupEventListeners();
    }

    setupEventListeners() {
        // Close button
        this.closeBtn.addEventListener('click', () => this.close());

        // Keyboard navigation
        document.addEventListener('keydown', (e) => {
            if (!this.isOpen()) return;

            switch(e.key) {
                case 'Escape':
                    this.close();
                    break;
                case 'ArrowLeft':
                    this.previous();
                    break;
                case 'ArrowRight':
                    this.next();
                    break;
            }
        });

        // Click outside to close
        this.lightbox.addEventListener('click', (e) => {
            if (e.target === this.lightbox) {
                this.close();
            }
        });

        // Navigation buttons
        this.prevBtn.addEventListener('click', () => this.previous());
        this.nextBtn.addEventListener('click', () => this.next());
    }

    /**
     * Open lightbox with single image
     */
    open(imageSrc, title = 'Property Image') {
        this.currentImages = [imageSrc];
        this.currentIndex = 0;
        this.titleElement.textContent = title;
        this.imageElement.src = imageSrc;
        this.updateCounter();
        this.lightbox.style.display = 'flex';

        // Hide navigation for single image
        this.prevBtn.style.display = 'none';
        this.nextBtn.style.display = 'none';
    }

    /**
     * Open lightbox with multiple images (gallery mode)
     */
    openGallery(images, title = 'Property Images', startIndex = 0) {
        this.currentImages = images;
        this.currentIndex = Math.max(0, Math.min(startIndex, images.length - 1));
        this.titleElement.textContent = title;
        this.showImage(this.currentIndex);
        this.lightbox.style.display = 'flex';

        // Show navigation for multiple images
        this.prevBtn.style.display = images.length > 1 ? 'flex' : 'none';
        this.nextBtn.style.display = images.length > 1 ? 'flex' : 'none';
    }

    close() {
        this.lightbox.style.display = 'none';
        this.currentImages = [];
        this.currentIndex = 0;
    }

    previous() {
        if (this.currentImages.length <= 1) return;
        this.currentIndex = (this.currentIndex - 1 + this.currentImages.length) % this.currentImages.length;
        this.showImage(this.currentIndex);
    }

    next() {
        if (this.currentImages.length <= 1) return;
        this.currentIndex = (this.currentIndex + 1) % this.currentImages.length;
        this.showImage(this.currentIndex);
    }

    showImage(index) {
        if (index < 0 || index >= this.currentImages.length) return;
        this.imageElement.src = this.currentImages[index];
        this.updateCounter();
    }

    updateCounter() {
        const total = this.currentImages.length;
        const current = this.currentIndex + 1;
        this.counterElement.textContent = `${current} / ${total}`;
    }

    isOpen() {
        return this.lightbox.style.display === 'flex';
    }
}

/**
 * Helper function to create mosaic viewer from element ID
 */
export function createMosaicViewer(lightboxId = 'lightbox') {
    const lightboxElement = document.getElementById(lightboxId);
    if (!lightboxElement) {
        throw new Error(`Lightbox element with ID "${lightboxId}" not found`);
    }
    return new MosaicViewer(lightboxElement);
}

export default MosaicViewer;

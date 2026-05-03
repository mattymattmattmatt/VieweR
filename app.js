// 3D Pano VieweR - Interactive Demo Engine
// Built with d for the immersive web

let canvas;
let ctx;
let WIDTH = 960;
let HEIGHT = 520;

let offset = 0;           // Current view offset (world X)
let targetOffset = 0;
let isDragging = false;
let lastMouseX = 0;
let velocity = 0;
let autoRotate = true;
let rotateSpeed = 1.0;
let zoom = 1.0;
let targetZoom = 1.0;
let time = 0;
let tiltX = 0;
let tiltY = 0;
let stereoMode = false;

let stars = [];
let mountainsFar = [];
let mountainsMid = [];
let palms = [];
let clouds = [];
let birds = [];

const WORLD_WIDTH = 2400;

// Hotspot data
const hotspots = [
    { x: 920, label: "Sunset Peak", desc: "The highest point in the cove. Locals say you can see the curvature of the Earth from here at golden hour." },
    { x: 1630, label: "Crystal Lagoon", desc: "A hidden tide pool where bioluminescent plankton light up the water every night. Perfect for night photography." },
    { x: 530, label: "Ancient Palm Grove", desc: "These palms are over 300 years old. The largest one is said to have been planted by the first settlers." }
];

// Initialize everything
function init() {
    canvas = document.getElementById('pano-canvas');
    ctx = canvas.getContext('2d', { alpha: true });
    
    // Set actual canvas size
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    
    // Generate world elements
    generateWorld();
    
    // Mouse / Touch events for panning
    const viewer = document.getElementById('viewer-container');
    
    viewer.addEventListener('mousedown', startDrag);
    window.addEventListener('mouseup', endDrag);
    window.addEventListener('mousemove', drag);
    
    // Touch support
    viewer.addEventListener('touchstart', handleTouchStart, { passive: false });
    viewer.addEventListener('touchmove', handleTouchMove, { passive: false });
    viewer.addEventListener('touchend', handleTouchEnd);
    
    // Wheel for zoom
    viewer.addEventListener('wheel', handleWheel, { passive: false });
    
    // 3D tilt effect on mouse move
    viewer.addEventListener('mousemove', handleTilt);
    viewer.addEventListener('mouseleave', () => {
        tiltX = 0;
        tiltY = 0;
    });
    
    // Keyboard shortcuts
    document.addEventListener('keydown', handleKeyboard);
    
    // Speed slider
    const speedSlider = document.getElementById('speed-slider');
    speedSlider.addEventListener('input', () => {
        rotateSpeed = parseFloat(speedSlider.value);
    });
    
    // Initial auto-rotate state
    document.getElementById('auto-rotate-btn').classList.add('active');
    
    // Start animation loop
    animate();
    
    // Subtle initial animation hint
    setTimeout(() => {
        targetOffset = 280;
    }, 800);
    
    // Easter egg: click logo in nav to spin
    const navLogo = document.querySelector('.nav-logo img');
    if (navLogo) {
        navLogo.addEventListener('click', () => {
            offset = (offset + 1200) % WORLD_WIDTH;
            targetOffset = offset;
            createBurstParticles(30);
        });
    }
    
    // Intersection observer for fade-ins
    initScrollAnimations();
}

// Generate procedural world elements
function generateWorld() {
    // Stars - scattered across the sky
    stars = [];
    for (let i = 0; i < 180; i++) {
        stars.push({
            x: Math.random() * WORLD_WIDTH,
            y: 40 + Math.random() * (HEIGHT * 0.45),
            size: Math.random() * 2.2 + 0.6,
            twinkle: Math.random() * Math.PI * 2,
            brightness: Math.random() * 0.6 + 0.6
        });
    }
    
    // Far mountains (distant blue-ish)
    mountainsFar = [];
    let x = 0;
    while (x < WORLD_WIDTH * 1.5) {
        const peakHeight = 110 + Math.random() * 85;
        mountainsFar.push({
            x: x,
            width: 180 + Math.random() * 220,
            height: peakHeight,
            color: '#1a2a4a'
        });
        x += 140 + Math.random() * 160;
    }
    
    // Mid mountains (warmer, closer)
    mountainsMid = [];
    x = 80;
    while (x < WORLD_WIDTH * 1.5) {
        const peakHeight = 145 + Math.random() * 120;
        mountainsMid.push({
            x: x,
            width: 210 + Math.random() * 190,
            height: peakHeight,
            color: '#2c3a5a'
        });
        x += 170 + Math.random() * 190;
    }
    
    // Palm trees
    palms = [];
    const palmPositions = [180, 420, 780, 1050, 1380, 1720, 2010, 2280];
    palmPositions.forEach((px, i) => {
        palms.push({
            x: px,
            y: HEIGHT * 0.72,
            scale: 0.85 + (i % 3) * 0.12,
            sway: Math.random() * Math.PI * 2,
            type: i % 2
        });
    });
    
    // Clouds
    clouds = [];
    for (let i = 0; i < 7; i++) {
        clouds.push({
            x: Math.random() * WORLD_WIDTH,
            y: 65 + Math.random() * 95,
            width: 85 + Math.random() * 110,
            speed: 0.12 + Math.random() * 0.18,
            opacity: 0.35 + Math.random() * 0.35
        });
    }
    
    // Birds
    birds = [];
    for (let i = 0; i < 5; i++) {
        birds.push({
            x: Math.random() * WORLD_WIDTH,
            y: 95 + Math.random() * 140,
            speed: 0.8 + Math.random() * 1.4,
            amp: 18 + Math.random() * 22,
            phase: Math.random() * Math.PI * 2
        });
    }
}

// Main animation loop
function animate() {
    time += 1;
    
    // Smooth interpolation
    offset = offset * 0.82 + targetOffset * 0.18;
    zoom = zoom * 0.9 + targetZoom * 0.1;
    
    // Auto rotate
    if (autoRotate) {
        targetOffset += 0.65 * rotateSpeed;
    }
    
    // Apply velocity (momentum)
    if (!isDragging) {
        targetOffset += velocity * 0.96;
        velocity *= 0.92;
    }
    
    // Wrap around world
    offset = ((offset % WORLD_WIDTH) + WORLD_WIDTH) % WORLD_WIDTH;
    targetOffset = ((targetOffset % WORLD_WIDTH) + WORLD_WIDTH) % WORLD_WIDTH;
    
    drawScene();
    
    requestAnimationFrame(animate);
}

// Draw the entire panoramic scene
function drawScene() {
    ctx.save();
    
    // Background sky gradient (sunset vibe)
    const skyGrad = ctx.createLinearGradient(0, 0, 0, HEIGHT * 0.65);
    skyGrad.addColorStop(0, '#0b1428');
    skyGrad.addColorStop(0.35, '#1a2f55');
    skyGrad.addColorStop(0.58, '#ff7e3d');
    skyGrad.addColorStop(0.82, '#ff4d1a');
    skyGrad.addColorStop(1, '#c23a00');
    
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    
    // Horizon glow
    const horizonGlow = ctx.createRadialGradient(
        WIDTH / 2, HEIGHT * 0.58, 40,
        WIDTH / 2, HEIGHT * 0.58, 380
    );
    horizonGlow.addColorStop(0, 'rgba(255, 200, 80, 0.35)');
    horizonGlow.addColorStop(0.5, 'rgba(255, 120, 40, 0.12)');
    horizonGlow.addColorStop(1, 'rgba(255, 80, 20, 0)');
    ctx.fillStyle = horizonGlow;
    ctx.fillRect(0, HEIGHT * 0.4, WIDTH, HEIGHT * 0.65);
    
    // === STARS ===
    ctx.fillStyle = '#ffffff';
    stars.forEach(star => {
        const drawX = ((star.x - offset * 0.08) % WORLD_WIDTH + WORLD_WIDTH) % WORLD_WIDTH;
        if (drawX > -30 && drawX < WIDTH + 30) {
            const twinkle = Math.sin(time * 0.08 + star.twinkle) * 0.5 + 0.5;
            const alpha = star.brightness * (0.6 + twinkle * 0.4);
            ctx.globalAlpha = alpha;
            ctx.beginPath();
            ctx.arc(drawX, star.y, star.size, 0, Math.PI * 2);
            ctx.fill();
            
            // Extra bright stars get a glow
            if (star.size > 1.8) {
                ctx.globalAlpha = alpha * 0.4;
                ctx.beginPath();
                ctx.arc(drawX, star.y, star.size * 2.8, 0, Math.PI * 2);
                ctx.fill();
            }
        }
    });
    ctx.globalAlpha = 1;
    
    // === CLOUDS (slow parallax) ===
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    clouds.forEach((cloud, i) => {
        const cloudOffset = (offset * cloud.speed * 0.3) % WORLD_WIDTH;
        const drawX = ((cloud.x - cloudOffset) % WORLD_WIDTH + WORLD_WIDTH) % WORLD_WIDTH;
        
        if (drawX > -cloud.width && drawX < WIDTH + cloud.width) {
            ctx.globalAlpha = cloud.opacity;
            drawCloud(ctx, drawX, cloud.y, cloud.width);
        }
    });
    ctx.globalAlpha = 1;
    
    // === FAR MOUNTAINS (very slow) ===
    ctx.strokeStyle = '#1a2a4a';
    ctx.lineWidth = 1.5;
    mountainsFar.forEach(m => {
        const drawX = ((m.x - offset * 0.15) % WORLD_WIDTH + WORLD_WIDTH) % WORLD_WIDTH;
        drawMountain(ctx, drawX, m.width, m.height, m.color, 0.6);
    });
    
    // === MID MOUNTAINS ===
    mountainsMid.forEach(m => {
        const drawX = ((m.x - offset * 0.38) % WORLD_WIDTH + WORLD_WIDTH) % WORLD_WIDTH;
        drawMountain(ctx, drawX, m.width, m.height, '#3a4a6a', 0.85);
    });
    
    // === SUN (center of the scene) ===
    const sunX = WIDTH * 0.5 + Math.sin(time * 0.003) * 3;
    const sunY = HEIGHT * 0.48;
    const sunSize = 46 * zoom;
    
    // Sun glow layers
    const sunGlow = ctx.createRadialGradient(sunX, sunY, sunSize * 0.3, sunX, sunY, sunSize * 2.8);
    sunGlow.addColorStop(0, 'rgba(255, 240, 150, 0.9)');
    sunGlow.addColorStop(0.3, 'rgba(255, 180, 60, 0.5)');
    sunGlow.addColorStop(0.65, 'rgba(255, 100, 20, 0.15)');
    sunGlow.addColorStop(1, 'transparent');
    
    ctx.fillStyle = sunGlow;
    ctx.beginPath();
    ctx.arc(sunX, sunY, sunSize * 2.8, 0, Math.PI * 2);
    ctx.fill();
    
    // Sun core
    ctx.fillStyle = '#fff9e6';
    ctx.beginPath();
    ctx.arc(sunX, sunY, sunSize, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.fillStyle = '#ffe066';
    ctx.beginPath();
    ctx.arc(sunX, sunY, sunSize * 0.72, 0, Math.PI * 2);
    ctx.fill();
    
    // === WATER / SEA ===
    const waterTop = HEIGHT * 0.63;
    const waterGrad = ctx.createLinearGradient(0, waterTop, 0, HEIGHT);
    waterGrad.addColorStop(0, '#0a2540');
    waterGrad.addColorStop(0.4, '#1a3a5c');
    waterGrad.addColorStop(1, '#0d2238');
    
    ctx.fillStyle = waterGrad;
    ctx.fillRect(0, waterTop, WIDTH, HEIGHT - waterTop);
    
    // Water reflection of sun
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = '#ffeb99';
    ctx.beginPath();
    ctx.ellipse(sunX, waterTop + 38, sunSize * 1.8, 22, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    
    // Animated water ripples
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 6; i++) {
        const rippleY = waterTop + 18 + i * 22;
        const ripplePhase = (time * 0.04 + i * 1.3) % (Math.PI * 2);
        ctx.beginPath();
        ctx.moveTo(0, rippleY);
        for (let x = 0; x < WIDTH; x += 18) {
            const yOff = Math.sin((x * 0.012) + ripplePhase) * (3.5 - i * 0.3);
            ctx.lineTo(x, rippleY + yOff);
        }
        ctx.stroke();
    }
    
    // === BEACH / SAND ===
    ctx.fillStyle = '#d4b48c';
    ctx.fillRect(0, HEIGHT * 0.71, WIDTH, HEIGHT * 0.12);
    
    // Sand texture / dunes
    ctx.fillStyle = 'rgba(180, 140, 90, 0.35)';
    ctx.beginPath();
    ctx.moveTo(0, HEIGHT * 0.71);
    ctx.quadraticCurveTo(WIDTH * 0.25, HEIGHT * 0.68, WIDTH * 0.5, HEIGHT * 0.73);
    ctx.quadraticCurveTo(WIDTH * 0.75, HEIGHT * 0.76, WIDTH, HEIGHT * 0.71);
    ctx.lineTo(WIDTH, HEIGHT * 0.83);
    ctx.lineTo(0, HEIGHT * 0.83);
    ctx.fill();
    
    // === PALM TREES (fastest parallax) ===
    palms.forEach((palm, index) => {
        const drawX = ((palm.x - offset * 0.92) % WORLD_WIDTH + WORLD_WIDTH) % WORLD_WIDTH;
        const swayAmount = Math.sin(time * 0.035 + palm.sway) * 0.8;
        
        if (drawX > -80 && drawX < WIDTH + 80) {
            drawPalmTree(ctx, drawX, palm.y, palm.scale, swayAmount, palm.type);
        }
    });
    
    // === BIRDS ===
    ctx.strokeStyle = '#334455';
    ctx.lineWidth = 1.8;
    birds.forEach((bird, i) => {
        const birdX = ((bird.x + (time * bird.speed * 0.6)) % WORLD_WIDTH + WORLD_WIDTH) % WORLD_WIDTH;
        const birdY = bird.y + Math.sin(time * 0.05 + bird.phase) * bird.amp;
        
        if (birdX > -20 && birdX < WIDTH + 20) {
            const wingFlap = Math.sin(time * 0.22 + i) * 7;
            
            ctx.beginPath();
            ctx.moveTo(birdX - 9, birdY);
            ctx.lineTo(birdX, birdY - wingFlap);
            ctx.lineTo(birdX + 9, birdY);
            ctx.stroke();
            
            ctx.beginPath();
            ctx.moveTo(birdX - 5, birdY + 2);
            ctx.lineTo(birdX, birdY + 6);
            ctx.lineTo(birdX + 5, birdY + 2);
            ctx.stroke();
        }
    });
    
    // === ATMOSPHERIC HAZE / FOG LAYERS ===
    const haze = ctx.createLinearGradient(0, HEIGHT * 0.55, 0, HEIGHT * 0.82);
    haze.addColorStop(0, 'rgba(30, 50, 80, 0.0)');
    haze.addColorStop(0.5, 'rgba(25, 42, 68, 0.18)');
    haze.addColorStop(1, 'rgba(18, 32, 52, 0.35)');
    ctx.fillStyle = haze;
    ctx.fillRect(0, HEIGHT * 0.52, WIDTH, HEIGHT * 0.35);
    
    // Subtle vignette
    const vignette = ctx.createRadialGradient(
        WIDTH / 2, HEIGHT / 2, Math.max(WIDTH, HEIGHT) * 0.35,
        WIDTH / 2, HEIGHT / 2, Math.max(WIDTH, HEIGHT) * 0.78
    );
    vignette.addColorStop(0, 'transparent');
    vignette.addColorStop(1, 'rgba(0,0,0,0.45)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    
    ctx.restore();
    
    // === 3D STEREO MODE OVERLAY ===
    if (stereoMode) {
        ctx.fillStyle = 'rgba(0, 240, 255, 0.08)';
        ctx.fillRect(0, 0, WIDTH / 2 - 4, HEIGHT);
        ctx.fillStyle = 'rgba(255, 107, 0, 0.08)';
        ctx.fillRect(WIDTH / 2 + 4, 0, WIDTH / 2 - 4, HEIGHT);
        
        // Center divider
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(WIDTH / 2, 0);
        ctx.lineTo(WIDTH / 2, HEIGHT);
        ctx.stroke();
        
        // Labels
        ctx.fillStyle = '#00f0ff';
        ctx.font = '700 11px Inter, sans-serif';
        ctx.fillText('LEFT EYE', 18, 28);
        ctx.fillStyle = '#ff6b00';
        ctx.fillText('RIGHT EYE', WIDTH / 2 + 18, 28);
    }
    
    // === COMPASS / DIRECTION INDICATOR ===
    const compassX = WIDTH - 68;
    const compassY = 52;
    const angle = ((offset / WORLD_WIDTH) * 360) % 360;
    
    ctx.strokeStyle = 'rgba(0,240,255,0.6)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(compassX, compassY, 26, 0, Math.PI * 2);
    ctx.stroke();
    
    ctx.fillStyle = '#00f0ff';
    ctx.font = '700 10px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(Math.round(angle) + '°', compassX, compassY + 4);
    
    // Small N marker
    ctx.strokeStyle = '#ff6b00';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(compassX, compassY - 18);
    ctx.lineTo(compassX, compassY - 26);
    ctx.stroke();
    
    ctx.fillStyle = '#ff6b00';
    ctx.fillText('N', compassX, compassY - 32);
    ctx.textAlign = 'left';
}

// Helper: Draw a stylized cloud
function drawCloud(ctx, x, y, w) {
    ctx.save();
    ctx.shadowColor = 'rgba(255,255,255,0.3)';
    ctx.shadowBlur = 18;
    
    const h = w * 0.38;
    ctx.beginPath();
    ctx.ellipse(x, y, w * 0.5, h, 0, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.beginPath();
    ctx.ellipse(x - w * 0.28, y - 4, w * 0.32, h * 0.9, 0, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.beginPath();
    ctx.ellipse(x + w * 0.26, y + 3, w * 0.35, h * 0.85, 0, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.restore();
}

// Helper: Draw a mountain range peak
function drawMountain(ctx, x, w, h, color, alpha = 1) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.strokeStyle = '#0f1c35';
    ctx.lineWidth = 2.5;
    
    const peakX = x + w / 2;
    
    ctx.beginPath();
    ctx.moveTo(x, HEIGHT * 0.63);
    ctx.lineTo(peakX - w * 0.18, HEIGHT * 0.63 - h);
    ctx.lineTo(peakX + w * 0.22, HEIGHT * 0.63 - h * 0.82);
    ctx.lineTo(x + w, HEIGHT * 0.63);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    
    // Snow cap
    if (h > 140) {
        ctx.fillStyle = '#e8f0ff';
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.moveTo(peakX - w * 0.12, HEIGHT * 0.63 - h * 0.88);
        ctx.lineTo(peakX, HEIGHT * 0.63 - h * 0.98);
        ctx.lineTo(peakX + w * 0.15, HEIGHT * 0.63 - h * 0.82);
        ctx.lineTo(peakX - w * 0.05, HEIGHT * 0.63 - h * 0.85);
        ctx.fill();
    }
    
    ctx.restore();
}

// Helper: Draw a detailed palm tree
function drawPalmTree(ctx, x, y, scale = 1, sway = 0, type = 0) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    
    const trunkHeight = 72;
    const trunkWidth = 11;
    
    // Trunk (curved with sway)
    ctx.strokeStyle = '#3a2a1f';
    ctx.lineWidth = trunkWidth;
    ctx.lineCap = 'round';
    ctx.shadowColor = 'rgba(0,0,0,0.4)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetX = 3;
    ctx.shadowOffsetY = 4;
    
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(sway * 1.8, -trunkHeight * 0.55, sway * 2.6, -trunkHeight);
    ctx.stroke();
    
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    
    // Trunk highlights
    ctx.strokeStyle = '#5c4633';
    ctx.lineWidth = 4.5;
    ctx.beginPath();
    ctx.moveTo(-2, 0);
    ctx.quadraticCurveTo(sway * 1.4, -trunkHeight * 0.55, sway * 2.2, -trunkHeight);
    ctx.stroke();
    
    // Palm fronds
    const frondCount = type === 0 ? 7 : 5;
    const frondLength = type === 0 ? 58 : 48;
    
    ctx.strokeStyle = '#1e3a1f';
    ctx.fillStyle = '#2a5a2f';
    ctx.lineWidth = 3.5;
    
    for (let i = 0; i < frondCount; i++) {
        const angle = (i / frondCount) * Math.PI * 2 + sway * 0.03;
        const len = frondLength * (0.75 + Math.random() * 0.25);
        
        ctx.save();
        ctx.rotate(angle);
        
        // Main frond
        ctx.beginPath();
        ctx.moveTo(0, -8);
        ctx.quadraticCurveTo(
            18 * Math.cos(sway * 0.4), -len * 0.5,
            22 * Math.cos(sway * 0.5), -len
        );
        ctx.stroke();
        
        // Leaf details
        ctx.fillStyle = i % 2 === 0 ? '#2a5a2f' : '#1e4a25';
        ctx.beginPath();
        ctx.moveTo(0, -8);
        ctx.lineTo(14, -len * 0.35);
        ctx.lineTo(8, -len * 0.65);
        ctx.lineTo(0, -len * 0.4);
        ctx.fill();
        
        ctx.restore();
    }
    
    // Coconuts
    ctx.fillStyle = '#4a2f1f';
    ctx.beginPath();
    ctx.arc(sway * 0.6, -trunkHeight + 6, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(sway * 0.3 - 7, -trunkHeight - 4, 5, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.restore();
}

// Drag handlers
function startDrag(e) {
    isDragging = true;
    lastMouseX = e.clientX;
    velocity = 0;
    autoRotate = false;
    document.getElementById('auto-rotate-btn').classList.remove('active');
    document.getElementById('rotate-text').textContent = '¶ Resume Rotation';
}

function endDrag() {
    isDragging = false;
}

function drag(e) {
    if (!isDragging) return;
    
    const delta = e.clientX - lastMouseX;
    targetOffset -= delta * 1.35;
    velocity = -delta * 1.35;
    lastMouseX = e.clientX;
}

function handleTouchStart(e) {
    if (e.touches.length === 1) {
        isDragging = true;
        lastMouseX = e.touches[0].clientX;
        velocity = 0;
        autoRotate = false;
        document.getElementById('auto-rotate-btn').classList.remove('active');
    }
}

function handleTouchMove(e) {
    if (!isDragging || e.touches.length !== 1) return;
    e.preventDefault();
    
    const delta = e.touches[0].clientX - lastMouseX;
    targetOffset -= delta * 1.35;
    velocity = -delta * 1.35;
    lastMouseX = e.touches[0].clientX;
}

function handleTouchEnd() {
    isDragging = false;
}

function handleWheel(e) {
    e.preventDefault();
    const zoomDelta = e.deltaY > 0 ? -0.08 : 0.08;
    targetZoom = Math.max(0.6, Math.min(2.4, targetZoom + zoomDelta));
}

function handleTilt(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    
    tiltX = (e.clientX - centerX) / (rect.width / 2) * 6;
    tiltY = (e.clientY - centerY) / (rect.height / 2) * 4;
    
    const container = document.getElementById('viewer-container');
    container.style.transform = `perspective(1200px) rotateX(${-tiltY}deg) rotateY(${tiltX}deg)`;
}

function handleKeyboard(e) {
    if (e.key === ' ' || e.key === 'k') {
        e.preventDefault();
        toggleAutoRotate();
    }
    if (e.key.toLowerCase() === 'r') {
        resetView();
    }
    if (e.key === 'f' || e.key === 'F') {
        enterFullscreen();
    }
    if (e.key === 'Escape' && stereoMode) {
        toggleStereo();
    }
}

// UI Functions
function toggleAutoRotate() {
    autoRotate = !autoRotate;
    const btn = document.getElementById('auto-rotate-btn');
    const text = document.getElementById('rotate-text');
    
    if (autoRotate) {
        btn.classList.add('active');
        text.textContent = 'ø Pause Rotation';
    } else {
        btn.classList.remove('active');
        text.textContent = '¶ Resume Rotation';
    }
}

function updateSpeed() {
    // Handled by event listener in init
}

function resetView() {
    targetOffset = 0;
    targetZoom = 1.0;
    velocity = 0;
    
    // Gentle camera move
    setTimeout(() => {
        targetOffset = 180;
    }, 420);
}

function enterFullscreen() {
    const container = document.getElementById('viewer-container');
    
    if (!document.fullscreenElement) {
        if (container.requestFullscreen) {
            container.requestFullscreen();
        } else if (container.webkitRequestFullscreen) {
            container.webkitRequestFullscreen();
        } else if (container.msRequestFullscreen) {
            container.msRequestFullscreen();
        }
    } else {
        document.exitFullscreen();
    }
}

function toggleStereo() {
    stereoMode = !stereoMode;
    const btns = document.querySelectorAll('.control-btn');
    btns.forEach(btn => {
        if (btn.textContent.includes('3D Stereo')) {
            btn.style.background = stereoMode ? 'var(--accent-cyan)' : '';
            btn.style.color = stereoMode ? '#05050f' : '';
        }
    });
    
    // Brief flash effect
    const flash = document.createElement('div');
    flash.style.cssText = 'position:absolute; top:0; left:0; right:0; bottom:0; background:rgba(0,240,255,0.2); pointer-events:none; z-index:10;';
    document.getElementById('viewer-container').appendChild(flash);
    setTimeout(() => flash.remove(), 180);
}

function showHotspotInfo(index) {
    const hs = hotspots[index];
    
    const modal = document.createElement('div');
    modal.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(5,5,15,0.92); z-index: 3000; display: flex;
        align-items: center; justify-content: center; padding: 20px;
    `;
    
    modal.innerHTML = `
        <div style="max-width: 460px; width: 100%; background: #0f0f23; border-radius: 20px; border: 1px solid #00f0ff; overflow: hidden; box-shadow: 0 0 60px rgba(0,240,255,0.3);">
            <div style="padding: 2rem 2rem 1.5rem; border-bottom: 1px solid #222;">
                <div style="display:flex; align-items:center; gap:12px; margin-bottom:1rem;">
                    <div style="width:42px; height:42px; background: linear-gradient(135deg, #00f0ff, #ff6b00); border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:1.4rem;">=Í</div>
                    <h3 style="margin:0; font-size:1.65rem; color:#fff;">${hs.label}</h3>
                </div>
                <p style="color:#a0a0c0; line-height:1.65; margin:0;">${hs.desc}</p>
            </div>
            
            <div style="padding:1.25rem 2rem; display:flex; gap:0.75rem; background:#0a0a1f;">
                <button onclick="this.closest('.modal').remove()" style="flex:1; padding:0.85rem; background:transparent; border:1px solid #444; color:#ccc; border-radius:12px; cursor:pointer; font-weight:600;">Close</button>
                <button onclick="bookmarkHotspot(${index}, this)" style="flex:1; padding:0.85rem; background:linear-gradient(135deg,#00f0ff,#ff6b00); color:#05050f; border:none; border-radius:12px; cursor:pointer; font-weight:700;">Save to Tour</button>
            </div>
        </div>
    `;
    
    modal.className = 'modal';
    document.body.appendChild(modal);
    
    // Close on background click
    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.remove();
    });
}

function bookmarkHotspot(index, btn) {
    btn.textContent = ' Saved!';
    btn.style.background = '#00c853';
    
    setTimeout(() => {
        const modal = btn.closest('.modal');
        if (modal) modal.remove();
        
        // Toast notification
        const toast = document.createElement('div');
        toast.style.cssText = 'position:fixed; bottom:30px; left:50%; transform:translateX(-50%); background:#111; color:#0f0; padding:14px 28px; border-radius:50px; font-size:0.95rem; box-shadow:0 10px 30px rgba(0,0,0,0.4); border:1px solid #00c853; z-index:4000;';
        toast.textContent = `=Í ${hotspots[index].label} added to your collection`;
        document.body.appendChild(toast);
        
        setTimeout(() => {
            toast.style.transition = 'all 0.4s ease';
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(-50%) translateY(20px)';
            setTimeout(() => toast.remove(), 400);
        }, 2200);
    }, 1100);
}

function showVideoModal() {
    const modal = document.getElementById('video-modal');
    modal.style.display = 'flex';
}

function hideVideoModal() {
    const modal = document.getElementById('video-modal');
    modal.style.display = 'none';
}

// Scroll-triggered animations
function initScrollAnimations() {
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('visible');
                observer.unobserve(entry.target);
            }
        });
    }, { threshold: 0.2 });
    
    document.querySelectorAll('.fade-in').forEach(el => {
        observer.observe(el);
    });
}

// Easter egg: Konami code for extra particles
let konami = '';
const konamiCode = '38384040373937396665';
document.addEventListener('keydown', (e) => {
    konami += e.keyCode;
    if (konami.length > konamiCode.length) konami = konami.slice(1);
    if (konami === konamiCode) {
        createBurstParticles(120);
        konami = '';
        const msg = document.createElement('div');
        msg.style.cssText = 'position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); color:#00f0ff; font-size:1.8rem; font-weight:800; text-shadow:0 0 30px #00f0ff; pointer-events:none; z-index:5000;';
        msg.textContent = '< MAXIMUM IMMERSION ACTIVATED';
        document.body.appendChild(msg);
        setTimeout(() => msg.remove(), 1600);
    }
});

function createBurstParticles(count) {
    const container = document.getElementById('viewer-container');
    for (let i = 0; i < count; i++) {
        const p = document.createElement('div');
        p.style.cssText = `position:absolute; width:4px; height:4px; background:#00f0ff; border-radius:50%; pointer-events:none; z-index:20;`;
        p.style.left = Math.random() * 100 + '%';
        p.style.top = Math.random() * 100 + '%';
        container.appendChild(p);
        
        const angle = Math.random() * Math.PI * 2;
        const dist = 60 + Math.random() * 90;
        const duration = 600 + Math.random() * 700;
        
        p.animate([
            { transform: 'translate(0,0) scale(1)', opacity: 1 },
            { transform: `translate(${Math.cos(angle) * dist}px, ${Math.sin(angle) * dist}px) scale(0.2)`, opacity: 0 }
        ], {
            duration: duration,
            easing: 'cubic-bezier(0.23, 1, 0.32, 1)'
        }).onfinish = () => p.remove();
    }
}

// Boot the application
window.onload = init;

// Expose some functions for console fun
window.PANO = { resetView, toggleAutoRotate, toggleStereo, createBurstParticles };
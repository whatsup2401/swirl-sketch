// ─────────────────────────────────────────────────────────────────
// Swirl Sketch – Fractal Zoom Ambient Wallpaper
//
// Architecture (two-pass per frame):
//   Pass 1 – feedbackShader  → renders into a half-res framebuffer
//            Reads the *previous* frame, zooms in, rotates slightly,
//            warps with noise, then mixes in fresh ridged-noise detail.
//            Ping-pongs between fboA ↔ fboB every frame.
//   Pass 2 – colorShader     → renders to the main canvas (full-res)
//            Samples the feedback texture and maps its luminance
//            through the color-preset palette system.
// ─────────────────────────────────────────────────────────────────

// ─── Global state ────────────────────────────────────────────────
let time = 0;                       // master clock (color shader)
let fractalTime = 0;                // independent clock (feedback shader)
let menuOpen = false;
let menuDiv;

// ── Color-preset transition (kept from original) ──
let currentColorPreset = 0;
let targetColorPreset  = 0;
let colorBlend         = 1.0;       // 0→1 lerp between current & target preset

// ── Auto-color cycling ──
let autoRandomizeColor    = false;
let colorChangeInterval   = 60000;  // ms between auto-switches
let lastColorChange       = 0;

// ── Random-color state: current (lerped) vs target ──
// "current" is what the shader sees each frame; "target" is where it's heading.
// Lerping prevents the jarring instant hue-jump that happened before.
let curRandHue   = 0.5, tgtRandHue   = 0.5;
let curRandSat   = 0.5, tgtRandSat   = 0.5;
let curRandVal   = 0.4, tgtRandVal   = 0.4;
let curRandSpd   = 0.01, tgtRandSpd  = 0.01;

// ── Fractal-zoom controls (exposed to UI sliders) ──
let zoomSpeed     = 1.0;   // 0.1 – 3.0   – how fast we zoom in
let warpStrength  = 0.5;   // 0.0 – 2.0   – noise-warp displacement magnitude
let detailAmount  = 0.5;   // 0.1 – 1.0   – how much fresh noise is injected

// ── Ping-pong framebuffers ──
let fboA, fboB;            // p5.Framebuffer objects (half-res)
let seedOffset = 0;        // random value flipped on Reset to change the noise seed

const colorNames = ['Ocean', 'Solar', 'Aurora', 'Neon', 'Forest', 'Sky', 'Random'];

// ─────────────────────────────────────────────────────────────────
// FEEDBACK SHADER  (pass 1 – writes into the half-res framebuffer)
//
// Uniforms fed from JS each frame:
//   uPrevFrame      – previous framebuffer texture (sampler2D)
//   uResolution     – framebuffer pixel size
//   uTime           – fractalTime (drives noise animation)
//   uZoomSpeed      – user slider
//   uWarpStrength   – user slider
//   uDetailAmount   – user slider
//   uSeed / uSeedOffset – 1.0 on seed-only frames; offset randomises noise
// ─────────────────────────────────────────────────────────────────
const feedbackSrc = `
precision highp float;

uniform sampler2D uPrevFrame;
uniform vec2  uResolution;
uniform float uTime;
uniform float uZoomSpeed;
uniform float uWarpStrength;
uniform float uDetailAmount;
uniform float uSeed;          // 1.0 = seed-mode (pure noise, no feedback read)
uniform float uSeedOffset;    // random offset so Reset gives different noise

// ── noise primitives ─────────────────────────────────────────────
float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);          // smoothstep the fraction
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// Ridged noise: folds smooth noise into sharp ridges → fractal look
float ridged(vec2 p) {
    return 1.0 - abs(noise(p) * 2.0 - 1.0);
}

// 3-octave ridged FBM  (cheap but convincing at this use)
float ridgedFBM(vec2 p) {
    float v = 0.0, a = 0.5;
    vec2 shift = vec2(100.0);
    for (int i = 0; i < 3; i++) {
        v += a * ridged(p);
        p  = p * 2.1 + shift;   // 2.1 avoids exact-power aliasing
        a *= 0.48;
    }
    return v;
}

void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;   // 0–1 across framebuffer

    // ── SEED MODE: bootstrap texture with multi-scale noise ──────
    // Runs once (or a few times) to populate the buffer before the
    // feedback loop starts; shader returns early so uPrevFrame is
    // never actually sampled.
    if (uSeed > 0.5) {
        vec2 pos = gl_FragCoord.xy;
        float d1 = ridgedFBM(pos * 0.03  + vec2(uSeedOffset * 100.0));
        float d2 = ridgedFBM(pos * 0.10  + vec2(uSeedOffset * 200.0 + 50.0));
        float d3 = ridgedFBM(pos * 0.28  + vec2(uSeedOffset * 300.0 + 100.0));
        gl_FragColor = vec4(vec3(d1 * 0.5 + d2 * 0.3 + d3 * 0.2), 1.0);
        return;
    }

    // ── FEEDBACK MODE ────────────────────────────────────────────
    vec2 center     = vec2(0.5);
    vec2 fromCenter = uv - center;

    // -- Zoom: shrink the sample region toward center each frame --
    // zoomPerFrame > 1 means we sample a *smaller* area → zoom in.
    // Accumulates exponentially across frames → infinite zoom feel.
    float zoomPerFrame = 1.0 + uZoomSpeed * 0.008;

    // -- Rotation: tiny per-frame angle accumulates into a slow spiral --
    float ang  = uZoomSpeed * 0.004;
    float cosA = cos(ang), sinA = sin(ang);
    vec2  rot  = vec2(
        fromCenter.x * cosA - fromCenter.y * sinA,
        fromCenter.x * sinA + fromCenter.y * cosA
    );

    // Combined zoom + rotation sample position
    vec2 sampleUV = center + rot / zoomPerFrame;

    // -- Nonlinear warp: noise-driven displacement gives the organic,
    //    non-uniform distortion that sells the "fractal" feel. ──────
    if (uWarpStrength > 0.001) {
        float n1 = noise(sampleUV * 14.0 + uTime * 0.4);
        float n2 = noise(sampleUV * 14.0 + vec2(7.3, 3.1) + uTime * 0.4);
        sampleUV += (vec2(n1, n2) - 0.5) * uWarpStrength * 0.018;
    }

    // Clamp to [0,1] – prevents hard black borders as we zoom
    sampleUV = clamp(sampleUV, 0.003, 0.997);

    // Sample the previous frame
    vec3 prev = texture2D(uPrevFrame, sampleUV).rgb;

    // -- Decay: gently pull brightness down each frame so highlights
    //    don't blow up over time. ───────────────────────────────────
    prev *= 0.976;

    // -- Detail injection: the KEY trick that keeps the image from
    //    smearing into uniformity. Fresh ridged noise is added every
    //    frame; on the *next* frame the zoom magnifies it, revealing
    //    "new structure" continuously. ───────────────────────────────
    vec2 pos      = gl_FragCoord.xy;
    float d1      = ridgedFBM(pos * 0.035 + uTime * 0.25);                // large blobs
    float d2      = ridgedFBM(pos * 0.12  + vec2(40.0) + uTime * 0.18);   // mid ridges
    float d3      = ridgedFBM(pos * 0.38  + vec2(80.0) + uTime * 0.12);   // fine grain
    float newDetail = d1 * 0.45 + d2 * 0.35 + d3 * 0.20;

    // Blend amount: detailAmount slider scales 0.04–0.12 injection per frame
    float injectStr = 0.04 + uDetailAmount * 0.08;
    vec3  result    = mix(prev, vec3(newDetail), injectStr);

    gl_FragColor = vec4(result, 1.0);
}
`;

// ─────────────────────────────────────────────────────────────────
// COLOR SHADER  (pass 2 – full-res to screen)
//
// Samples the fractal texture produced by the feedback loop and
// maps its grayscale value through the color-preset palette system
// (identical palette logic to the original swirl patterns).
// ─────────────────────────────────────────────────────────────────
const colorSrc = `
precision highp float;

uniform sampler2D uFractal;            // the feedback-loop texture
uniform vec2  uResolution;
uniform float uTime;
uniform int   uColorPreset;
uniform int   uTargetColorPreset;
uniform float uColorBlend;             // 0→1 lerp for preset transitions

// Smoothly-lerped random-color params (JS side lerps toward targets)
uniform float uRandHue;
uniform float uRandSat;
uniform float uRandVal;
uniform float uRandSpd;

// ── colour utilities ─────────────────────────────────────────────
vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

// Returns (hue, sat, val, hueSpeed) for a colour preset.
// 'pattern' is the fractal luminance value (0–1) that drives variation.
vec4 getColorParams(int preset, float angle, float normDist, float pattern) {
    float hue, sat, val, hueSpeed;

    if (preset == 0) {
        // Ocean – teals & blues
        hue      = 0.52 + sin(pattern * 0.6) * 0.06;
        sat      = 0.5  + pattern * 0.15;
        val      = 0.35 + pattern * 0.25;
        hueSpeed = 0.01;
    } else if (preset == 1) {
        // Solar – oranges & golds
        hue      = 0.06 + sin(pattern * 0.8) * 0.05;
        sat      = 0.55 + pattern * 0.2;
        val      = 0.4  + pattern * 0.3;
        hueSpeed = 0.008;
    } else if (preset == 2) {
        // Aurora – greens & teals
        hue      = 0.38 + sin(pattern * 0.7) * 0.1;
        sat      = 0.45 + pattern * 0.2;
        val      = 0.35 + pattern * 0.28;
        hueSpeed = 0.012;
    } else if (preset == 3) {
        // Neon – purples & magentas
        hue      = 0.78 + sin(pattern * 0.8) * 0.08;
        sat      = 0.5  + pattern * 0.18;
        val      = 0.38 + pattern * 0.28;
        hueSpeed = 0.015;
    } else if (preset == 4) {
        // Forest – rich greens
        hue      = 0.32 + sin(pattern * 0.5) * 0.06;
        sat      = 0.4  + pattern * 0.18;
        val      = 0.3  + pattern * 0.25;
        hueSpeed = 0.007;
    } else if (preset == 5) {
        // Sky – bright blues & whites
        hue      = 0.57 + sin(pattern * 0.4) * 0.03;
        sat      = 0.55 - pattern * 0.35;
        val      = 0.55 + pattern * 0.4;
        hueSpeed = 0.004;
    } else {
        // Random – uses the JS-side lerped values (no jarring jumps)
        hue      = uRandHue + sin(pattern * 0.5) * 0.08;
        sat      = uRandSat + pattern * 0.15;
        val      = uRandVal + pattern * 0.25;
        hueSpeed = uRandSpd;
    }

    return vec4(hue, sat, val, hueSpeed);
}

void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;

    // Sample fractal texture – single channel is enough (it's greyscale)
    float fractalVal = texture2D(uFractal, uv).r;

    // Screen-space polar coords for angular/radial colour variation
    vec2  center    = uResolution * 0.5;
    vec2  fromCen   = gl_FragCoord.xy - center;
    float normDist  = length(fromCen) / length(center);
    float angle     = atan(fromCen.y, fromCen.x);

    // Blend current → target colour preset (smooth transition)
    vec4 col1 = getColorParams(uColorPreset,       angle, normDist, fractalVal);
    vec4 col2 = getColorParams(uTargetColorPreset, angle, normDist, fractalVal);
    vec4 cp   = mix(col1, col2, uColorBlend);

    float hue = fract(cp.x + uTime * cp.w);   // slow hue drift over time
    float sat = clamp(cp.y, 0.25, 0.75);
    float val = clamp(cp.z, 0.25, 0.95);

    // Fractal luminance modulates brightness & saturation
    val = clamp(val * (0.55 + fractalVal * 0.60), 0.15, 1.0);
    sat = clamp(sat * (0.70 + fractalVal * 0.40), 0.10, 1.0);

    // Subtle breathing pulse (replaces the old per-particle breathing)
    float breath = sin(uTime * 0.4 + fractalVal * 3.0) * 0.5 + 0.5;
    val *= 0.90 + breath * 0.10;

    vec3 col = hsv2rgb(vec3(hue, sat, val));
    gl_FragColor = vec4(col, 1.0);
}
`;

// Shared vertex shader (both passes)
const vertSrc = `
attribute vec3 aPosition;
void main() { gl_Position = vec4(aPosition, 1.0); }
`;

// ─── Compiled shader handles ─────────────────────────────────────
let feedbackShader, colorShader;

function preload() {
    feedbackShader = createShader(vertSrc, feedbackSrc);
    colorShader    = createShader(vertSrc, colorSrc);
}

// ─────────────────────────────────────────────────────────────────
// SETUP
// ─────────────────────────────────────────────────────────────────
function setup() {
    createCanvas(windowWidth, windowHeight, WEBGL);
    pixelDensity(1);
    noStroke();

    // Half-res framebuffers – the feedback loop runs here;
    // the final colour pass upscales to full canvas.
    let fbW = Math.floor(width  / 2);
    let fbH = Math.floor(height / 2);
    fboA = createFramebuffer({ width: fbW, height: fbH });
    fboB = createFramebuffer({ width: fbW, height: fbH });

    seedOffset = random(1000);
    seedFractal();   // populate fboA with noise + run warmup iterations

    createMenu();

    lastColorChange = millis();

    // Initialise random-colour lerp state (current = target so no jump on first frame)
    tgtRandHue  = random(1.0);
    curRandHue  = tgtRandHue;
    tgtRandSat  = random(0.4, 0.6);
    curRandSat  = tgtRandSat;
    tgtRandVal  = random(0.3, 0.5);
    curRandVal  = tgtRandVal;
    tgtRandSpd  = random(0.004, 0.015);
    curRandSpd  = tgtRandSpd;
}

// ─── Seed & warmup ───────────────────────────────────────────────
// Phase 1: render pure multi-scale noise into fboA (seed mode).
// Phase 2: run 20 feedback iterations so zoom/warp/detail have time
//          to build up structure before the user sees the first frame.
function seedFractal() {
    let fbW = Math.floor(width  / 2);
    let fbH = Math.floor(height / 2);

    // Phase 1 – seed fboA with noise
    fboA.begin();
    shader(feedbackShader);
    feedbackShader.setUniform('uPrevFrame',    fboB.color);  // dummy – not read in seed mode
    feedbackShader.setUniform('uResolution',   [fbW, fbH]);
    feedbackShader.setUniform('uTime',         random(100));
    feedbackShader.setUniform('uSeed',         1.0);
    feedbackShader.setUniform('uSeedOffset',   seedOffset);
    feedbackShader.setUniform('uZoomSpeed',    1.0);
    feedbackShader.setUniform('uWarpStrength', 0.5);
    feedbackShader.setUniform('uDetailAmount', 1.0);
    quad(-1, -1, 1, -1, 1, 1, -1, 1);
    fboA.end();

    // Phase 2 – warmup feedback loop (builds up zoom/warp structure)
    for (let i = 0; i < 20; i++) {
        fboB.begin();
        shader(feedbackShader);
        feedbackShader.setUniform('uPrevFrame',    fboA.color);
        feedbackShader.setUniform('uResolution',   [fbW, fbH]);
        feedbackShader.setUniform('uTime',         i * 0.12);
        feedbackShader.setUniform('uSeed',         0.0);
        feedbackShader.setUniform('uSeedOffset',   0.0);
        feedbackShader.setUniform('uZoomSpeed',    1.0);
        feedbackShader.setUniform('uWarpStrength', 0.5);
        feedbackShader.setUniform('uDetailAmount', 0.8);
        quad(-1, -1, 1, -1, 1, 1, -1, 1);
        fboB.end();

        [fboA, fboB] = [fboB, fboA];   // swap ping-pong
    }
}

// ─────────────────────────────────────────────────────────────────
// DRAW  (called every frame by p5)
// ─────────────────────────────────────────────────────────────────
function draw() {
    time        += 0.016;
    fractalTime += 0.016;

    // ── Auto-colour cycling ──────────────────────────────────────
    let now = millis();
    if (autoRandomizeColor && now - lastColorChange > colorChangeInterval) {
        let pick = Math.floor(random(colorNames.length));
        while (pick === targetColorPreset) pick = Math.floor(random(colorNames.length));
        setColorPreset(pick);
        lastColorChange = now;
    }

    // ── Colour-preset blend (lerp current → target) ─────────────
    if (colorBlend < 1.0) {
        colorBlend += 0.015;
        if (colorBlend >= 1.0) {
            colorBlend         = 1.0;
            currentColorPreset = targetColorPreset;
        }
    }

    // ── Smooth random-colour lerp (fixes the jarring jump) ──────
    // Hue uses shortest-path wrapping; sat/val/spd are plain lerp.
    let lt = 0.025;
    curRandHue = lerpHueWrap(curRandHue, tgtRandHue, lt);
    curRandSat = lerp(curRandSat, tgtRandSat, lt);
    curRandVal = lerp(curRandVal, tgtRandVal, lt);
    curRandSpd = lerp(curRandSpd, tgtRandSpd, lt);

    // ── PASS 1: feedback shader (half-res) ───────────────────────
    let fbW = Math.floor(width  / 2);
    let fbH = Math.floor(height / 2);

    fboB.begin();
    shader(feedbackShader);
    feedbackShader.setUniform('uPrevFrame',    fboA.color);
    feedbackShader.setUniform('uResolution',   [fbW, fbH]);
    feedbackShader.setUniform('uTime',         fractalTime);
    feedbackShader.setUniform('uSeed',         0.0);
    feedbackShader.setUniform('uSeedOffset',   0.0);
    feedbackShader.setUniform('uZoomSpeed',    zoomSpeed);
    feedbackShader.setUniform('uWarpStrength', warpStrength);
    feedbackShader.setUniform('uDetailAmount', detailAmount);
    quad(-1, -1, 1, -1, 1, 1, -1, 1);
    fboB.end();

    [fboA, fboB] = [fboB, fboA];   // fboA now holds the latest frame

    // ── PASS 2: colour shader (full-res → screen) ────────────────
    shader(colorShader);
    colorShader.setUniform('uFractal',           fboA.color);
    colorShader.setUniform('uResolution',        [width, height]);
    colorShader.setUniform('uTime',              time);
    colorShader.setUniform('uColorPreset',       currentColorPreset);
    colorShader.setUniform('uTargetColorPreset', targetColorPreset);
    colorShader.setUniform('uColorBlend',        colorBlend);
    colorShader.setUniform('uRandHue',           curRandHue);
    colorShader.setUniform('uRandSat',           curRandSat);
    colorShader.setUniform('uRandVal',           curRandVal);
    colorShader.setUniform('uRandSpd',           curRandSpd);
    quad(-1, -1, 1, -1, 1, 1, -1, 1);
}

// ── Utility: shortest-path hue lerp (0–1 wrapping circle) ──────
function lerpHueWrap(cur, tgt, t) {
    let d = tgt - cur;
    if (d >  0.5) d -= 1.0;   // wrap the short way around
    if (d < -0.5) d += 1.0;
    return ((cur + d * t) % 1.0 + 1.0) % 1.0;
}

// ─────────────────────────────────────────────────────────────────
// WINDOW RESIZE
// ─────────────────────────────────────────────────────────────────
function windowResized() {
    resizeCanvas(windowWidth, windowHeight);
    // Recreate framebuffers at new half-res and re-seed
    fboA = createFramebuffer({ width: Math.floor(width  / 2), height: Math.floor(height / 2) });
    fboB = createFramebuffer({ width: Math.floor(width  / 2), height: Math.floor(height / 2) });
    seedFractal();
}

// ─────────────────────────────────────────────────────────────────
// COLOUR PRESET API
// ─────────────────────────────────────────────────────────────────
window.setColorPreset = function(preset) {
    if (preset === 6) generateRandomColor();   // pick new random target colours
    if (preset !== targetColorPreset) {
        currentColorPreset = targetColorPreset;
        targetColorPreset  = preset;
        colorBlend         = 0.0;              // restart blend
        updateMenuButtons();
    }
}

// Sets new *target* random-colour values; JS lerps current → target
// over ~40 frames so the transition is smooth rather than instant.
function generateRandomColor() {
    tgtRandHue = random(1.0);
    tgtRandSat = random(0.4, 0.6);
    tgtRandVal = random(0.3, 0.5);
    tgtRandSpd = random(0.004, 0.015);
}

window.randomize = function() {
    setColorPreset(Math.floor(random(colorNames.length)));
}

// ── Fractal controls ─────────────────────────────────────────────
window.resetFractal = function() {
    seedOffset = random(1000);   // new seed → different noise
    seedFractal();
}

window.onSliderInput = function(id) {
    let val = parseFloat(document.getElementById(id).value);
    document.getElementById(id + '-val').textContent = val.toFixed(1);

    if (id === 'zoom-speed')    zoomSpeed    = val;
    if (id === 'warp-strength') warpStrength = val;
    if (id === 'detail-amount') detailAmount = val;
}

// ── Auto-colour toggle ───────────────────────────────────────────
window.toggleAutoColor = function() {
    autoRandomizeColor = document.getElementById('auto-color').checked;
    if (autoRandomizeColor) lastColorChange = millis();
}

window.toggleMenu = function() {
    menuOpen = !menuOpen;
    menuDiv.classList.toggle('open', menuOpen);
}

// ─────────────────────────────────────────────────────────────────
// KEYBOARD
// ─────────────────────────────────────────────────────────────────
function keyPressed() {
    if (key === 'm' || key === 'M') toggleMenu();
    if (key === 's' || key === 'S') saveCanvas('swirl_' + Math.floor(random(10000)), 'png');
    if (key === 'r' || key === 'R') randomize();
}

// ─────────────────────────────────────────────────────────────────
// MENU  (built imperatively, same dark-glass style as before)
// ─────────────────────────────────────────────────────────────────
function createMenu() {
    menuDiv = document.createElement('div');
    menuDiv.id = 'preset-menu';
    menuDiv.innerHTML = `
        <div class="menu-header">
            <span>Settings</span>
            <span class="close-btn" onclick="toggleMenu()">×</span>
        </div>

        <!-- Colour presets (unchanged) -->
        <div class="menu-section">
            <div class="section-title">Colors</div>
            <div class="preset-grid" id="color-presets"></div>
        </div>

        <!-- Fractal zoom controls (replaces old Pattern section) -->
        <div class="menu-section">
            <div class="section-title">Fractal Zoom</div>
            <div class="slider-group">
                <div class="slider-row">
                    <div class="slider-header">
                        <span class="slider-label">Zoom Speed</span>
                        <span class="slider-value" id="zoom-speed-val">1.0</span>
                    </div>
                    <input type="range" id="zoom-speed" min="0.1" max="3" step="0.1" value="1" oninput="onSliderInput('zoom-speed')">
                </div>
                <div class="slider-row">
                    <div class="slider-header">
                        <span class="slider-label">Warp Strength</span>
                        <span class="slider-value" id="warp-strength-val">0.5</span>
                    </div>
                    <input type="range" id="warp-strength" min="0" max="2" step="0.05" value="0.5" oninput="onSliderInput('warp-strength')">
                </div>
                <div class="slider-row">
                    <div class="slider-header">
                        <span class="slider-label">Detail Amount</span>
                        <span class="slider-value" id="detail-amount-val">0.5</span>
                    </div>
                    <input type="range" id="detail-amount" min="0.1" max="1" step="0.05" value="0.5" oninput="onSliderInput('detail-amount')">
                </div>
            </div>
            <button class="reset-btn" onclick="resetFractal()">Reset Fractal</button>
        </div>

        <!-- Auto-colour toggle -->
        <div class="menu-section">
            <div class="toggle-container">
                <label class="toggle-label">
                    <input type="checkbox" id="auto-color" onchange="toggleAutoColor()">
                    <span class="toggle-text">Auto Colors</span>
                </label>
            </div>
        </div>

        <!-- Randomize -->
        <div class="menu-section">
            <button class="randomize-btn" onclick="randomize()">Randomize Color</button>
        </div>
    `;
    document.body.appendChild(menuDiv);

    // ── Styles ─────────────────────────────────────────────────
    const style = document.createElement('style');
    style.textContent = `
        #preset-menu {
            position: fixed;
            top: 20px;
            right: 20px;
            width: 210px;
            background: rgba(15, 15, 20, 0.92);
            backdrop-filter: blur(10px);
            border-radius: 12px;
            padding: 0;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            color: #fff;
            display: none;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
            border: 1px solid rgba(255, 255, 255, 0.1);
            overflow: hidden;
        }
        #preset-menu.open { display: block; }

        .menu-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 14px 16px;
            background: rgba(255, 255, 255, 0.05);
            font-weight: 600;
            font-size: 14px;
            letter-spacing: 0.5px;
        }
        .close-btn {
            cursor: pointer;
            opacity: 0.6;
            font-size: 20px;
            line-height: 1;
            transition: opacity 0.2s;
        }
        .close-btn:hover { opacity: 1; }

        .menu-section { padding: 12px 16px; }
        .section-title {
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 1px;
            opacity: 0.5;
            margin-bottom: 10px;
        }

        /* colour preset buttons */
        .preset-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 8px;
        }
        .preset-btn {
            background: rgba(255, 255, 255, 0.08);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 8px;
            padding: 10px 8px;
            color: #fff;
            font-size: 12px;
            cursor: pointer;
            transition: all 0.2s;
            text-align: center;
        }
        .preset-btn:hover {
            background: rgba(255, 255, 255, 0.15);
            border-color: rgba(255, 255, 255, 0.2);
        }
        .preset-btn.active {
            background: rgba(100, 140, 255, 0.3);
            border-color: rgba(100, 140, 255, 0.5);
        }

        /* fractal-zoom sliders */
        .slider-group {
            display: flex;
            flex-direction: column;
            gap: 14px;
        }
        .slider-row {
            display: flex;
            flex-direction: column;
            gap: 5px;
        }
        .slider-header {
            display: flex;
            justify-content: space-between;
            align-items: baseline;
        }
        .slider-label {
            font-size: 12px;
            opacity: 0.8;
        }
        .slider-value {
            font-size: 11px;
            opacity: 0.45;
            font-variant-numeric: tabular-nums;
        }
        input[type="range"] {
            -webkit-appearance: none;
            appearance: none;
            width: 100%;
            height: 4px;
            border-radius: 2px;
            background: rgba(255, 255, 255, 0.15);
            outline: none;
            cursor: pointer;
        }
        input[type="range"]::-webkit-slider-thumb {
            -webkit-appearance: none;
            appearance: none;
            width: 15px;
            height: 15px;
            border-radius: 50%;
            background: rgba(100, 140, 255, 0.85);
            box-shadow: 0 1px 4px rgba(0,0,0,0.3);
            cursor: pointer;
            transition: background 0.15s;
        }
        input[type="range"]::-webkit-slider-thumb:hover {
            background: rgba(120, 160, 255, 1);
        }
        input[type="range"]::-moz-range-thumb {
            width: 15px;
            height: 15px;
            border-radius: 50%;
            background: rgba(100, 140, 255, 0.85);
            border: none;
            box-shadow: 0 1px 4px rgba(0,0,0,0.3);
            cursor: pointer;
        }

        /* reset button (sits below sliders) */
        .reset-btn {
            width: 100%;
            margin-top: 10px;
            background: rgba(255, 255, 255, 0.07);
            border: 1px solid rgba(255, 255, 255, 0.12);
            border-radius: 8px;
            padding: 9px;
            color: rgba(255, 255, 255, 0.7);
            font-size: 12px;
            cursor: pointer;
            transition: all 0.2s;
        }
        .reset-btn:hover {
            background: rgba(255, 255, 255, 0.14);
            color: #fff;
        }

        /* auto-colour toggle */
        .toggle-container {
            display: flex;
            flex-direction: column;
            gap: 10px;
        }
        .toggle-label {
            display: flex;
            align-items: center;
            gap: 10px;
            cursor: pointer;
            font-size: 12px;
        }
        .toggle-label input[type="checkbox"] {
            width: 16px;
            height: 16px;
            cursor: pointer;
            accent-color: rgba(100, 140, 255, 0.8);
        }
        .toggle-text { opacity: 0.8; }

        /* randomize button */
        .randomize-btn {
            width: 100%;
            background: linear-gradient(135deg, rgba(100, 140, 255, 0.3), rgba(180, 100, 255, 0.3));
            border: 1px solid rgba(255, 255, 255, 0.15);
            border-radius: 8px;
            padding: 12px;
            color: #fff;
            font-size: 13px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s;
        }
        .randomize-btn:hover {
            background: linear-gradient(135deg, rgba(100, 140, 255, 0.5), rgba(180, 100, 255, 0.5));
        }

        /* one-time hint toast */
        .hint {
            position: fixed;
            bottom: 20px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(0, 0, 0, 0.5);
            padding: 8px 16px;
            border-radius: 20px;
            font-family: -apple-system, BlinkMacSystemFont, sans-serif;
            font-size: 12px;
            color: rgba(255, 255, 255, 0.6);
            pointer-events: none;
            transition: opacity 0.5s;
        }
    `;
    document.head.appendChild(style);

    // Populate colour-preset buttons
    const colorGrid = document.getElementById('color-presets');
    colorNames.forEach((name, i) => {
        const btn = document.createElement('button');
        btn.className = 'preset-btn' + (i === 0 ? ' active' : '');
        btn.textContent = name;
        btn.onclick = () => setColorPreset(i);
        colorGrid.appendChild(btn);
    });

    // Hint toast
    const hint = document.createElement('div');
    hint.className  = 'hint';
    hint.textContent = 'Press M for menu';
    document.body.appendChild(hint);
    setTimeout(() => { hint.style.opacity = '0'; }, 3000);
    setTimeout(() => { hint.remove(); },            3500);
}

function updateMenuButtons() {
    document.querySelectorAll('#color-presets .preset-btn').forEach((btn, i) => {
        btn.classList.toggle('active', i === targetColorPreset);
    });
}

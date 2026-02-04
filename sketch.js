// ─────────────────────────────────────────────────────────────────
// Julia Set Loop – Seamless 300s shader animation
// Single-pass shader rendering with smooth iteration coloring.
// ─────────────────────────────────────────────────────────────────

let juliaShader;
let menuOpen = false;
let menuDiv;

const loopDuration = 300.0; // seconds
let loopStartMs = 0;

// UI-controlled parameters
let hueShift = 0.55;
let maxIterations = 140;
let zoomSpeed = 0.8;
let cAmplitude = 0.35;

const vertSrc = `
attribute vec3 aPosition;
void main() { gl_Position = vec4(aPosition, 1.0); }
`;

const juliaSrc = `
precision highp float;

uniform vec2 uResolution;
uniform float uLoopTime;      // 0–1
uniform float uHue;
uniform float uZoomSpeed;
uniform float uCAmplitude;
uniform float uMaxIterations;

vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;

    float t = uLoopTime;
    float phase = 6.28318530718 * t;

    float logZoom = sin(phase) * (0.25 + uZoomSpeed * 0.35);
    float zoom = exp(logZoom);

    vec2 center = vec2(-0.1, 0.0);
    vec2 drift = vec2(cos(phase * 0.8), sin(phase)) * 0.08;
    vec2 z = (uv / zoom) + center + drift;

    vec2 c = vec2(-0.4, 0.6) + uCAmplitude * vec2(cos(phase), sin(phase));

    float iter = 0.0;
    float maxIter = max(10.0, uMaxIterations);
    float radius2 = 16.0;
    float escape = 0.0;

    for (int i = 0; i < 400; i++) {
        if (float(i) >= maxIter) break;
        float x = z.x * z.x - z.y * z.y + c.x;
        float y = 2.0 * z.x * z.y + c.y;
        z = vec2(x, y);
        float mag2 = dot(z, z);
        if (mag2 > radius2) {
            escape = mag2;
            iter = float(i);
            break;
        }
    }

    float smoothIter = iter;
    if (escape > 0.0) {
        smoothIter = iter + 1.0 - log2(log2(sqrt(escape)));
    }

    float norm = clamp(smoothIter / maxIter, 0.0, 1.0);

    float edge = 1.0 - smoothstep(0.0, 0.03, fwidth(norm));
    float glow = pow(norm, 0.6);
    float value = clamp(glow + edge * 0.35, 0.0, 1.0);

    float hue = fract(uHue + norm * 0.18 + sin(phase) * 0.03);
    float sat = 0.65 - norm * 0.25;

    vec3 col = hsv2rgb(vec3(hue, sat, value));
    gl_FragColor = vec4(col, 1.0);
}
`;

function preload() {
    juliaShader = createShader(vertSrc, juliaSrc);
}

function setup() {
    createCanvas(windowWidth, windowHeight, WEBGL);
    pixelDensity(1);
    noStroke();
    loopStartMs = millis();
    createMenu();
}

function draw() {
    let elapsed = (millis() - loopStartMs) / 1000.0;
    let loopTime = (elapsed % loopDuration) / loopDuration;

    shader(juliaShader);
    juliaShader.setUniform('uResolution', [width, height]);
    juliaShader.setUniform('uLoopTime', loopTime);
    juliaShader.setUniform('uHue', hueShift);
    juliaShader.setUniform('uZoomSpeed', zoomSpeed);
    juliaShader.setUniform('uCAmplitude', cAmplitude);
    juliaShader.setUniform('uMaxIterations', maxIterations);
    quad(-1, -1, 1, -1, 1, 1, -1, 1);
}

function windowResized() {
    resizeCanvas(windowWidth, windowHeight);
}

window.onSliderInput = function(id) {
    let val = parseFloat(document.getElementById(id).value);
    if (id === 'max-iter') {
        document.getElementById(id + '-val').textContent = Math.round(val);
    } else {
        document.getElementById(id + '-val').textContent = val.toFixed(2);
    }

    if (id === 'hue-shift') hueShift = val;
    if (id === 'max-iter') maxIterations = val;
    if (id === 'zoom-speed') zoomSpeed = val;
    if (id === 'c-amp') cAmplitude = val;
}

window.resetFractal = function() {
    loopStartMs = millis();
}

window.toggleMenu = function() {
    menuOpen = !menuOpen;
    menuDiv.classList.toggle('open', menuOpen);
}

function keyPressed() {
    if (key === 'm' || key === 'M') toggleMenu();
    if (key === 's' || key === 'S') saveCanvas('julia_' + Math.floor(random(10000)), 'png');
    if (key === 'r' || key === 'R') resetFractal();
}

function createMenu() {
    menuDiv = document.createElement('div');
    menuDiv.id = 'preset-menu';
    menuDiv.innerHTML = `
        <div class="menu-header">
            <span>Settings</span>
            <span class="close-btn" onclick="toggleMenu()">×</span>
        </div>

        <div class="menu-section">
            <div class="section-title">Hue</div>
            <div class="slider-row">
                <div class="slider-header">
                    <span class="slider-label">Hue Shift</span>
                    <span class="slider-value" id="hue-shift-val">0.55</span>
                </div>
                <input type="range" id="hue-shift" min="0" max="1" step="0.01" value="0.55" oninput="onSliderInput('hue-shift')">
            </div>
        </div>

        <div class="menu-section">
            <div class="section-title">Fractal</div>
            <div class="slider-group">
                <div class="slider-row">
                    <div class="slider-header">
                        <span class="slider-label">Quality (Max Iterations)</span>
                        <span class="slider-value" id="max-iter-val">140</span>
                    </div>
                    <input type="range" id="max-iter" min="60" max="240" step="10" value="140" oninput="onSliderInput('max-iter')">
                </div>
                <div class="slider-row">
                    <div class="slider-header">
                        <span class="slider-label">Zoom Speed</span>
                        <span class="slider-value" id="zoom-speed-val">0.80</span>
                    </div>
                    <input type="range" id="zoom-speed" min="0.2" max="1.5" step="0.05" value="0.8" oninput="onSliderInput('zoom-speed')">
                </div>
                <div class="slider-row">
                    <div class="slider-header">
                        <span class="slider-label">C-Path Amplitude</span>
                        <span class="slider-value" id="c-amp-val">0.35</span>
                    </div>
                    <input type="range" id="c-amp" min="0" max="0.6" step="0.01" value="0.35" oninput="onSliderInput('c-amp')">
                </div>
            </div>
            <button class="reset-btn" onclick="resetFractal()">Reset</button>
        </div>
    `;
    document.body.appendChild(menuDiv);

    const style = document.createElement('style');
    style.textContent = `
        #preset-menu {
            position: fixed;
            top: 20px;
            right: 20px;
            width: 240px;
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

        .reset-btn {
            width: 100%;
            margin-top: 12px;
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

    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Press M for menu';
    document.body.appendChild(hint);
    setTimeout(() => { hint.style.opacity = '0'; }, 3000);
    setTimeout(() => { hint.remove(); }, 3500);
}

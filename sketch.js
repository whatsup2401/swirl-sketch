// ─────────────────────────────────────────────────────────────────
// Julia Loop – Smooth Julia set fragment shader with seamless loop
// ─────────────────────────────────────────────────────────────────

let juliaShader;
let menuOpen = false;
let menuDiv;

const LOOP_DURATION = 300.0; // seconds

// UI-controlled parameters
let hue = 0.58;
let maxIterations = 140;
let zoomSpeed = 0.8;
let cAmplitude = 0.25;

const defaults = {
    hue: 0.58,
    maxIterations: 140,
    zoomSpeed: 0.8,
    cAmplitude: 0.25,
};

const vertSrc = `#version 300 es
in vec3 aPosition;
in vec2 aTexCoord;

uniform mat4 uProjectionMatrix;
uniform mat4 uModelViewMatrix;

out vec2 vUv;

void main() {
    vUv = aTexCoord;
    gl_Position = uProjectionMatrix * uModelViewMatrix * vec4(aPosition, 1.0);
}
`;

const fragSrc = `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uLoopPhase;
uniform float uHue;
uniform int uMaxIter;
uniform float uZoomSpeed;
uniform float uCAmplitude;

in vec2 vUv;
out vec4 fragColor;

const int MAX_ITER = 300;

vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

void main() {
    vec2 fragCoord = vUv * uResolution;
    vec2 uv = (fragCoord - 0.5 * uResolution) / uResolution.y;

    float phase = uLoopPhase * 6.28318530718;

    float zoomAmp = uZoomSpeed * 0.25;
    float baseScale = 2.4;
    float zoom = exp(sin(phase) * zoomAmp);
    float scale = baseScale / zoom;

    vec2 drift = vec2(0.15 * cos(phase * 0.5), 0.12 * sin(phase)) * 0.12;

    vec2 z = uv * scale + drift;
    vec2 c = vec2(-0.7, 0.27015) + uCAmplitude * vec2(cos(phase), sin(phase * 2.0));

    int iter = 0;
    float escaped = 0.0;
    for (int i = 0; i < MAX_ITER; i++) {
        if (i >= uMaxIter) break;
        float x = (z.x * z.x - z.y * z.y) + c.x;
        float y = (2.0 * z.x * z.y) + c.y;
        z = vec2(x, y);
        if (dot(z, z) > 4.0) {
            iter = i;
            escaped = 1.0;
            break;
        }
    }

    float normIter = 0.0;
    if (escaped > 0.5) {
        float logZn = log(dot(z, z)) / 2.0;
        float nu = log(logZn / log(2.0)) / log(2.0);
        normIter = (float(iter) + 1.0 - nu) / float(uMaxIter);
    }

    float glow = pow(clamp(normIter, 0.0, 1.0), 0.7);
    float grad = length(vec2(dFdx(normIter), dFdy(normIter)));
    float edge = smoothstep(0.0, 0.02, grad * 4.0);

    float hueShift = uHue + normIter * 0.35 + sin(phase * 0.5) * 0.02;
    float sat = mix(0.35, 0.85, glow);
    float val = mix(0.05, 1.0, glow);

    vec3 col = hsv2rgb(vec3(fract(hueShift), sat, val));
    col += edge * 0.35;

    fragColor = vec4(col, 1.0);
}
`;

function preload() {
    juliaShader = createShader(vertSrc, fragSrc);
}

function setup() {
    createCanvas(windowWidth, windowHeight, WEBGL);
    pixelDensity(1);
    noStroke();
    rectMode(CENTER);
    createMenu();
    logShaderErrors(juliaShader);
}

function draw() {
    const t = millis() / 1000.0;
    const loopPhase = (t % LOOP_DURATION) / LOOP_DURATION;

    shader(juliaShader);
    juliaShader.setUniform('uResolution', [width, height]);
    juliaShader.setUniform('uLoopPhase', loopPhase);
    juliaShader.setUniform('uHue', hue);
    juliaShader.setUniform('uMaxIter', maxIterations);
    juliaShader.setUniform('uZoomSpeed', zoomSpeed);
    juliaShader.setUniform('uCAmplitude', cAmplitude);
    rect(0, 0, width, height);
}

function windowResized() {
    resizeCanvas(windowWidth, windowHeight);
}

window.onSliderInput = function(id) {
    const el = document.getElementById(id);
    const val = parseFloat(el.value);
    const label = document.getElementById(id + '-val');

    if (id === 'hue') {
        hue = val;
        label.textContent = val.toFixed(2);
    }
    if (id === 'quality') {
        maxIterations = Math.round(val);
        label.textContent = maxIterations;
    }
    if (id === 'zoom-speed') {
        zoomSpeed = val;
        label.textContent = val.toFixed(2);
    }
    if (id === 'c-amplitude') {
        cAmplitude = val;
        label.textContent = val.toFixed(2);
    }
}

window.resetFractal = function() {
    hue = defaults.hue;
    maxIterations = defaults.maxIterations;
    zoomSpeed = defaults.zoomSpeed;
    cAmplitude = defaults.cAmplitude;

    setSliderValue('hue', hue, hue.toFixed(2));
    setSliderValue('quality', maxIterations, maxIterations);
    setSliderValue('zoom-speed', zoomSpeed, zoomSpeed.toFixed(2));
    setSliderValue('c-amplitude', cAmplitude, cAmplitude.toFixed(2));
}

function setSliderValue(id, value, labelValue) {
    const slider = document.getElementById(id);
    const label = document.getElementById(id + '-val');
    if (slider) slider.value = value;
    if (label) label.textContent = labelValue;
}

function logShaderErrors(shader) {
    if (!shader) return;
    const gl = shader._gl || (typeof _renderer !== 'undefined' ? _renderer.GL : null);
    if (!gl || !shader._glProgram) return;

    const program = shader._glProgram;
    const linked = gl.getProgramParameter(program, gl.LINK_STATUS);
    if (!linked) {
        console.error('Shader link error:', gl.getProgramInfoLog(program));
    }

    const vert = shader._vertShader;
    if (vert && !gl.getShaderParameter(vert, gl.COMPILE_STATUS)) {
        console.error('Vertex shader error:', gl.getShaderInfoLog(vert));
    }

    const frag = shader._fragShader;
    if (frag && !gl.getShaderParameter(frag, gl.COMPILE_STATUS)) {
        console.error('Fragment shader error:', gl.getShaderInfoLog(frag));
    }
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
            <div class="slider-group">
                <div class="slider-row">
                    <div class="slider-header">
                        <span class="slider-label">Hue</span>
                        <span class="slider-value" id="hue-val">0.58</span>
                    </div>
                    <input type="range" id="hue" min="0" max="1" step="0.01" value="0.58" oninput="onSliderInput('hue')">
                </div>
            </div>
        </div>

        <div class="menu-section">
            <div class="section-title">Fractal</div>
            <div class="slider-group">
                <div class="slider-row">
                    <div class="slider-header">
                        <span class="slider-label">Quality (Max Iterations)</span>
                        <span class="slider-value" id="quality-val">140</span>
                    </div>
                    <input type="range" id="quality" min="60" max="220" step="1" value="140" oninput="onSliderInput('quality')">
                </div>
                <div class="slider-row">
                    <div class="slider-header">
                        <span class="slider-label">Zoom Speed</span>
                        <span class="slider-value" id="zoom-speed-val">0.80</span>
                    </div>
                    <input type="range" id="zoom-speed" min="0" max="2" step="0.05" value="0.8" oninput="onSliderInput('zoom-speed')">
                </div>
                <div class="slider-row">
                    <div class="slider-header">
                        <span class="slider-label">C-Path Amplitude</span>
                        <span class="slider-value" id="c-amplitude-val">0.25</span>
                    </div>
                    <input type="range" id="c-amplitude" min="0" max="0.6" step="0.01" value="0.25" oninput="onSliderInput('c-amplitude')">
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
            width: 230px;
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

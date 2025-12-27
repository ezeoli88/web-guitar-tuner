// ============================================
// CONSTANTES Y CONFIGURACIÓN
// ============================================

/**
 * Notas musicales con sus frecuencias de referencia (A4 = 440 Hz)
 * Cubre desde C2 hasta B6 para guitarra y más
 */
const NOTE_FREQUENCIES: { note: string; frequency: number }[] = [];
const NOTE_NAMES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
];

// Generar tabla de frecuencias (C0 a B8)
for (let octave = 0; octave <= 8; octave++) {
  for (let i = 0; i < 12; i++) {
    const noteNumber = octave * 12 + i;
    // A4 (nota #57) = 440 Hz
    const frequency = 440 * Math.pow(2, (noteNumber - 57) / 12);
    NOTE_FREQUENCIES.push({
      note: NOTE_NAMES[i],
      frequency: frequency,
    });
  }
}

// Configuración del audio
const FFT_SIZE = 4096; // Aumentado para mejor resolución en frecuencias bajas (E2)
const MIN_FREQUENCY = 65; // Hz - un poco debajo de E2 (82Hz)
const MAX_FREQUENCY = 1000; // Hz - cubre hasta E4 y armónicos
const MIN_RMS_THRESHOLD = 0.005; // Umbral detectado para ambientes ruidosos
const CENTS_TOLERANCE = 5; // Tolerancia para "afinado" (verde)

// ============================================
// REFERENCIAS DEL DOM (CACHEADAS)
// ============================================

const tunerContainer = document.getElementById("tuner-container") as HTMLElement;
const noteDisplay = document.getElementById("note-display") as HTMLElement;
const octaveDisplay = document.getElementById("octave-display") as HTMLElement;
const frequencyDisplay = document.getElementById("frequency-display") as HTMLElement;
const needle = document.getElementById("needle") as HTMLElement;
const centsDisplay = document.getElementById("cents-display") as HTMLElement;
const startBtn = document.getElementById("start-btn") as HTMLButtonElement;
const btnIcon = document.getElementById("btn-icon") as HTMLElement;
const btnText = document.getElementById("btn-text") as HTMLElement;
const statusBar = document.getElementById("status-bar") as HTMLElement;

// Elementos para selección de nota
const modeAutoBtn = document.getElementById("mode-auto-btn") as HTMLButtonElement;
const modeManualBtn = document.getElementById("mode-manual-btn") as HTMLButtonElement;
const targetNoteDisplay = document.getElementById("target-note-display") as HTMLElement;
const targetNoteName = document.getElementById("target-note-name") as HTMLElement;
const targetNoteFreq = document.getElementById("target-note-freq") as HTMLElement;
const stringButtons = document.querySelectorAll(".string-btn") as NodeListOf<HTMLButtonElement>;

// ============================================
// ESTADO DE LA APLICACIÓN
// ============================================

let audioContext: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let microphone: MediaStreamAudioSourceNode | null = null;
let isListening = false;
let animationFrameId: number | null = null;
let audioBuffer: Float32Array;

// Estado de selección de nota
type TunerMode = "auto" | "manual";
let currentMode: TunerMode = "auto";
let selectedNote: {
  note: string;
  octave: number;
  frequency: number;
} | null = null;

// ============================================
// ALGORITMO DE AUTOCORRELACIÓN
// ============================================

/**
 * Detecta la frecuencia fundamental usando una versión optimizada de autocorrelación.
 * Se limita el rango de búsqueda para evitar cálculos innecesarios y mejorar el rendimiento.
 */
function autocorrelate(buffer: Float32Array, sampleRate: number): number {
  const SIZE = buffer.length;

  // 1. Calcular RMS para verificar nivel de señal
  let sumSquares = 0;
  for (let i = 0; i < SIZE; i++) {
    sumSquares += buffer[i] * buffer[i];
  }
  const rms = Math.sqrt(sumSquares / SIZE);

  if (rms < MIN_RMS_THRESHOLD) return -1;

  // 2. Definir rango de búsqueda de Lags (periodos)
  const minLag = Math.floor(sampleRate / MAX_FREQUENCY);
  const maxLag = Math.floor(sampleRate / MIN_FREQUENCY);

  // 3. Calcular Correlación solo en el rango necesario
  let bestLag = -1;
  let maxCorrelation = -Infinity;
  const windowSize = 2048;
  const correlations = new Float32Array(maxLag + 1);

  for (let lag = minLag; lag <= maxLag; lag++) {
    let correlation = 0;
    for (let i = 0; i < windowSize; i++) {
      correlation += buffer[i] * buffer[i + lag];
    }
    correlations[lag] = correlation;
  }

  // 4. Encontrar el mejor pico
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (
      correlations[lag] > correlations[lag - 1] &&
      correlations[lag] > correlations[lag + 1]
    ) {
      if (correlations[lag] > maxCorrelation) {
        maxCorrelation = correlations[lag];
        bestLag = lag;
      }
      if (correlations[lag] > 0.9 * correlations[0]) {
        break;
      }
    }
  }

  if (bestLag === -1 || maxCorrelation < 0.01) return -1;

  // 5. Interpolación parabólica
  let refinedLag = bestLag;
  if (bestLag > 0 && bestLag < maxLag) {
    const y1 = correlations[bestLag - 1];
    const y2 = correlations[bestLag];
    const y3 = correlations[bestLag + 1];
    const a = (y1 + y3 - 2 * y2) / 2;
    const b = (y3 - y1) / 2;
    if (a !== 0) {
      refinedLag = bestLag - b / (2 * a);
    }
  }

  return sampleRate / refinedLag;
}

// ============================================
// FUNCIONES DE NOTAS MUSICALES
// ============================================

/**
 * Encuentra la nota más cercana a una frecuencia dada
 */
function findClosestNote(frequency: number): {
  note: string;
  octave: number;
  frequency: number;
} {
  const semitones = 12 * Math.log2(frequency / 440);
  const noteIndex = Math.round(semitones) + 57;

  if (noteIndex < 0 || noteIndex >= NOTE_FREQUENCIES.length) {
    return { note: "--", octave: 0, frequency: 0 };
  }

  const octave = Math.floor(noteIndex / 12);
  const noteInOctave = noteIndex % 12;
  const targetFrequency = NOTE_FREQUENCIES[noteIndex].frequency;

  return {
    note: NOTE_NAMES[noteInOctave],
    octave: octave,
    frequency: targetFrequency,
  };
}

/**
 * Calcula la desviación en cents entre dos frecuencias
 */
function calculateCents(detected: number, target: number): number {
  return 1200 * Math.log2(detected / target);
}

// ============================================
// RENDERIZADO DE UI
// ============================================

/**
 * Actualiza la UI con los valores detectados
 */
function updateUI(
  frequency: number,
  note: string,
  octave: number,
  cents: number
): void {
  noteDisplay.textContent = note;
  octaveDisplay.textContent = octave > 0 ? String(octave) : "-";
  frequencyDisplay.textContent = `${frequency.toFixed(1)} Hz`;

  const centsRounded = Math.round(cents);
  const centsSign = centsRounded >= 0 ? "+" : "";
  centsDisplay.textContent = `${centsSign}${centsRounded} cents`;

  const rotation = Math.max(-45, Math.min(45, cents * 0.9));
  needle.style.transform = `translateX(-50%) rotate(${rotation}deg)`;

  const isInTune = Math.abs(cents) <= CENTS_TOLERANCE;

  if (isInTune) {
    tunerContainer.classList.remove("border-red-500/50", "border-yellow-500/50");
    tunerContainer.classList.add("border-green-500/50");
    noteDisplay.classList.remove("text-white", "text-yellow-400", "text-red-400");
    noteDisplay.classList.add("text-green-400");
    needle.classList.remove("from-red-500", "to-orange-400", "from-yellow-500", "to-yellow-400");
    needle.classList.add("from-green-500", "to-green-400");
  } else if (Math.abs(cents) <= 20) {
    tunerContainer.classList.remove("border-green-500/50", "border-red-500/50");
    tunerContainer.classList.add("border-yellow-500/50");
    noteDisplay.classList.remove("text-white", "text-green-400", "text-red-400");
    noteDisplay.classList.add("text-yellow-400");
    needle.classList.remove("from-green-500", "to-green-400", "from-red-500", "to-orange-400");
    needle.classList.add("from-yellow-500", "to-yellow-400");
  } else {
    tunerContainer.classList.remove("border-green-500/50", "border-yellow-500/50");
    tunerContainer.classList.add("border-red-500/50");
    noteDisplay.classList.remove("text-white", "text-green-400", "text-yellow-400");
    noteDisplay.classList.add("text-red-400");
    needle.classList.remove("from-green-500", "to-green-400", "from-yellow-500", "to-yellow-400");
    needle.classList.add("from-red-500", "to-orange-400");
  }
}

/**
 * Resetea la UI al estado inicial
 */
function resetUI(): void {
  noteDisplay.textContent = "--";
  octaveDisplay.textContent = "-";
  frequencyDisplay.textContent = "-- Hz";
  centsDisplay.textContent = "0 cents";
  needle.style.transform = "translateX(-50%) rotate(0deg)";

  tunerContainer.classList.remove("border-green-500/50", "border-yellow-500/50", "border-red-500/50");
  noteDisplay.classList.remove("text-green-400", "text-yellow-400", "text-red-400");
  noteDisplay.classList.add("text-white");
  needle.classList.remove("from-green-500", "to-green-400", "from-yellow-500", "to-yellow-400");
  needle.classList.add("from-red-500", "to-orange-400");
}

// ============================================
// LOOP DE ANIMACIÓN
// ============================================

function audioLoop(): void {
  if (!analyser || !isListening) return;

  analyser.getFloatTimeDomainData(audioBuffer);
  const frequency = autocorrelate(audioBuffer, audioContext!.sampleRate);

  if (frequency > 0) {
    let note: string;
    let octave: number;
    let targetFreq: number;

    if (currentMode === "manual" && selectedNote) {
      note = selectedNote.note;
      octave = selectedNote.octave;
      targetFreq = selectedNote.frequency;
    } else {
      const closest = findClosestNote(frequency);
      note = closest.note;
      octave = closest.octave;
      targetFreq = closest.frequency;
    }

    const cents = calculateCents(frequency, targetFreq);
    updateUI(frequency, note, octave, cents);
  } else {
    statusBar.textContent = "Esperando audio...";
  }

  animationFrameId = requestAnimationFrame(audioLoop);
}

// ============================================
// MANEJO DEL AUDIO
// ============================================

async function startAudio(): Promise<void> {
  try {
    audioContext = new AudioContext();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    microphone = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    microphone.connect(analyser);

    audioBuffer = new Float32Array(analyser.fftSize);
    isListening = true;

    btnIcon.textContent = "⏹️";
    btnText.textContent = "Detener";
    startBtn.classList.remove("from-indigo-600", "to-purple-600");
    startBtn.classList.add("from-red-600", "to-rose-600");
    statusBar.textContent = "🎸 Escuchando... Toca una cuerda";

    audioLoop();
  } catch (error) {
    console.error("Error al acceder al micrófono:", error);
    statusBar.textContent = "❌ Error: No se pudo acceder al micrófono";
  }
}

function stopAudio(): void {
  isListening = false;
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
  if (microphone) {
    microphone.disconnect();
    microphone = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  analyser = null;

  resetUI();
  btnIcon.textContent = "🎤";
  btnText.textContent = "Iniciar Afinador";
  startBtn.classList.remove("from-red-600", "to-rose-600");
  startBtn.classList.add("from-indigo-600", "to-purple-600");
  statusBar.textContent = "Presiona el botón para comenzar";
}

// ============================================
// FUNCIONES DE MODO Y SELECCIÓN DE NOTA
// ============================================

function setAutoMode(): void {
  currentMode = "auto";
  selectedNote = null;
  modeAutoBtn.classList.remove("bg-slate-700", "text-slate-400");
  modeAutoBtn.classList.add("bg-indigo-600", "text-white");
  modeManualBtn.classList.remove("bg-indigo-600", "text-white");
  modeManualBtn.classList.add("bg-slate-700", "text-slate-400");
  targetNoteDisplay.classList.add("hidden");
  stringButtons.forEach((btn) => {
    btn.classList.remove("bg-indigo-600", "border-indigo-500");
    btn.classList.add("bg-slate-700/50", "border-transparent");
  });
  if (isListening) statusBar.textContent = "🎸 Modo Auto: Detectando cualquier nota...";
}

function setManualMode(): void {
  currentMode = "manual";
  modeManualBtn.classList.remove("bg-slate-700", "text-slate-400");
  modeManualBtn.classList.add("bg-indigo-600", "text-white");
  modeAutoBtn.classList.remove("bg-indigo-600", "text-white");
  modeAutoBtn.classList.add("bg-slate-700", "text-slate-400");
  targetNoteDisplay.classList.remove("hidden");
  if (!selectedNote) {
    targetNoteName.textContent = "Selecciona una cuerda";
    targetNoteFreq.textContent = "";
  }
  if (isListening && !selectedNote) statusBar.textContent = "🎯 Modo Manual: Selecciona una cuerda para afinar";
}

function selectNote(
  note: string,
  octave: number,
  frequency: number,
  button: HTMLButtonElement
): void {
  selectedNote = { note, octave, frequency };
  if (currentMode !== "manual") setManualMode();
  targetNoteName.textContent = `${note}${octave}`;
  targetNoteFreq.textContent = `${frequency.toFixed(2)} Hz`;
  stringButtons.forEach((btn) => {
    btn.classList.remove("bg-indigo-600", "border-indigo-500");
    btn.classList.add("bg-slate-700/50", "border-transparent");
  });
  button.classList.remove("bg-slate-700/50", "border-transparent");
  button.classList.add("bg-indigo-600", "border-indigo-500");
  if (isListening) statusBar.textContent = `🎯 Afinando a ${note}${octave} (${frequency.toFixed(2)} Hz)`;
}

// ============================================
// EVENT LISTENERS
// ============================================

startBtn.addEventListener("click", () => {
  if (isListening) stopAudio();
  else startAudio();
});

modeAutoBtn.addEventListener("click", setAutoMode);
modeManualBtn.addEventListener("click", setManualMode);

stringButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const note = button.dataset.note!;
    const octave = parseInt(button.dataset.octave!, 10);
    const frequency = parseFloat(button.dataset.frequency!);
    selectNote(note, octave, frequency, button);
  });
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden && isListening) stopAudio();
});

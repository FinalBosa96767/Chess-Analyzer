
import { Chess } from "https://cdn.jsdelivr.net/npm/chess.js@1.4.0/+esm";

const $ = id => document.getElementById(id);

const glyph = {
  wk:"♔", wq:"♕", wr:"♖", wb:"♗", wn:"♘", wp:"♙",
  bk:"♚", bq:"♛", br:"♜", bb:"♝", bn:"♞", bp:"♟"
};

let game = new Chess();
let positions = [];
let sanMoves = [];
let analysis = [];
let cursor = 0;
let selectedSquare = null;
let boardFlipped = false;
let stopRequested = false;

let worker = null;
let engineReady = false;
let busy = false;

let currentScore = null;
let currentDepth = 0;
let resolveSearch = null;
let rejectSearch = null;
let searchTimeout = null;

// =========================
// INTERFACE
// =========================

function setEngine(text, ok = false) {
  $("engineState").innerHTML =
    `<i style="background:${ok ? "#78c99b" : "#e0b75d"}"></i> ${text}`;
}

function makeBoard(fen, bestMove = null) {
  const temp = new Chess(fen);
  const board = temp.board();
  const el = $("board");
  el.innerHTML = "";

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const boardRow = boardFlipped ? 7 - r : r;
      const boardCol = boardFlipped ? 7 - c : c;
      const rank = 8 - boardRow;
      const file = "abcdefgh"[boardCol];
      const squareName = file + rank;
      const square = document.createElement("div");
      square.className = `square ${(boardRow + boardCol) % 2 === 0 ? "light" : "dark"}`;
      square.dataset.square = squareName;
      square.setAttribute("aria-label", squareName);
      if (selectedSquare === squareName) square.classList.add("selected");

      const piece = board[boardRow][boardCol];
      if (piece) {
        const span = document.createElement("span");
        span.className = `piece ${piece.color === "w" ? "piece-white" : "piece-black"}`;
        span.textContent = glyph[piece.color + piece.type];
        span.draggable = true;
        span.addEventListener("dragstart", event => {
          selectedSquare = squareName;
          event.dataTransfer.setData("text/plain", squareName);
        });
        square.append(span);
      }
      square.addEventListener("click", () => handleBoardSquare(squareName));
      square.addEventListener("dragover", event => event.preventDefault());
      square.addEventListener("drop", event => {
        event.preventDefault();
        const from = event.dataTransfer.getData("text/plain") || selectedSquare;
        if (from) playManualMove(from, squareName);
      });
      el.append(square);
    }
  }

  if (bestMove && bestMove.length >= 4 && bestMove !== "(none)") {
    const fromFile = bestMove.charCodeAt(0) - 97;
    const fromRank = Number(bestMove[1]);
    const toFile = bestMove.charCodeAt(2) - 97;
    const toRank = Number(bestMove[3]);
    if ([fromFile, toFile].every(n => n >= 0 && n < 8) && [fromRank, toRank].every(n => n >= 1 && n <= 8)) {
      const svgNS = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(svgNS, "svg");
      svg.setAttribute("class", "best-move-arrow");
      svg.setAttribute("viewBox", "0 0 800 800");
      svg.setAttribute("aria-hidden", "true");
      const defs = document.createElementNS(svgNS, "defs");
      const marker = document.createElementNS(svgNS, "marker");
      marker.setAttribute("id", "best-arrow-head");
      marker.setAttribute("markerWidth", "7");
      marker.setAttribute("markerHeight", "7");
      marker.setAttribute("refX", "5.5");
      marker.setAttribute("refY", "3.5");
      marker.setAttribute("orient", "auto");
      const head = document.createElementNS(svgNS, "path");
      head.setAttribute("d", "M0,0 L7,3.5 L0,7 Z");
      head.setAttribute("fill", "#20b879");
      marker.append(head);
      defs.append(marker);
      svg.append(defs);
      const coord = (file, rank) => boardFlipped
        ? { x: (7 - file) * 100 + 50, y: (rank - 1) * 100 + 50 }
        : { x: file * 100 + 50, y: (8 - rank) * 100 + 50 };
      const a = coord(fromFile, fromRank);
      const b = coord(toFile, toRank);
      const line = document.createElementNS(svgNS, "line");
      line.setAttribute("x1", String(a.x)); line.setAttribute("y1", String(a.y));
      line.setAttribute("x2", String(b.x)); line.setAttribute("y2", String(b.y));
      line.setAttribute("stroke", "#20b879"); line.setAttribute("stroke-width", "13");
      line.setAttribute("stroke-linecap", "round"); line.setAttribute("opacity", "0.88");
      line.setAttribute("marker-end", "url(#best-arrow-head)");
      svg.append(line); el.append(svg);
    }
  }
}

function handleBoardSquare(square) {
  const position = new Chess(positions[cursor] || new Chess().fen());
  const piece = position.get(square);
  if (!selectedSquare) {
    if (piece && piece.color === position.turn()) {
      selectedSquare = square;
      render();
    }
    return;
  }
  if (selectedSquare === square) {
    selectedSquare = null;
    render();
    return;
  }
  if (piece && piece.color === position.turn()) {
    selectedSquare = square;
    render();
    return;
  }
  playManualMove(selectedSquare, square);
}

function playManualMove(from, to) {
  try {
    const position = new Chess(positions[cursor] || new Chess().fen());
    const move = position.move({ from, to, promotion: "q" });
    selectedSquare = null;
    if (!move) { render(); return; }
    positions = positions.slice(0, cursor + 1);
    sanMoves = sanMoves.slice(0, cursor);
    analysis = analysis.slice(0, cursor);
    positions.push(position.fen());
    sanMoves.push(move.san);
    cursor++;
    $("moveCount").textContent = `${sanMoves.length} lances`;
    $("analyzeBtn").disabled = !engineReady || !sanMoves.length || busy;
    $("accuracyWhite").textContent = "—";
    $("accuracyBlack").textContent = "—";
    $("accuracyWhiteSmall").textContent = "—";
    $("accuracyBlackSmall").textContent = "—";
    $("whiteAccuracyBar").style.width = "0%";
    $("blackAccuracyBar").style.width = "0%";
    $("classificationSummary").innerHTML = '<span class="empty">Analise novamente para classificar os lances.</span>';
    showMoves(); render();
  } catch (error) {
    selectedSquare = null;
    render();
  }
}

function bestMoveSan(fen, uci) {
  if (!uci || uci === "(none)" || uci.length < 4) return null;
  try {
    const position = new Chess(fen);
    const move = position.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci[4] || "q"
    });
    return move ? move.san : null;
  } catch {
    return null;
  }
}

function render() {
  if (!positions.length) return;
  const positionBest = cursor === 0 ? analysis[0]?.bestMove : analysis[cursor - 1]?.nextBestMove;
  makeBoard(positions[cursor], positionBest);
  const bestSan = bestMoveSan(positions[cursor], positionBest);
  const sideToMove = new Chess(positions[cursor]).turn() === "w" ? "brancas" : "pretas";
  $("bestMoveLabel").textContent = bestSan ? `Melhor para ${sideToMove}: ${bestSan}` : "Melhor lance: —";
  $("moveCounter").textContent = `${cursor} / ${sanMoves.length}`;
  $("turnLabel").textContent = cursor === 0 ? "Posição inicial" : `Após ${cursor} ${cursor === 1 ? "lance" : "lances"}`;
  $("prevBtn").disabled = cursor === 0;
  $("nextBtn").disabled = cursor === sanMoves.length;
  $("firstBtn").disabled = cursor === 0;
  $("lastBtn").disabled = cursor === sanMoves.length;
  const row = analysis[cursor - 1];
  const initialRow = analysis[0];
  const scoreText = cursor === 0 ? (initialRow?.preScoreText || "—") : (row?.scoreText || "—");
  $("evalLabel").textContent = scoreText;
  $("engineLineMove").textContent = bestSan || "—";
  $("engineLineEval").textContent = scoreText;
  $("engineLineDepth").textContent = positionBest ? `Profundidade ${cursor === 0 ? initialRow?.depth || 0 : row?.depth || 0}` : "Aguardando análise";
  $("engineDepthLabel").textContent = `Depth ${Number($("analysisDepth").value) || 12}`;
  const cp = cursor === 0 ? (initialRow?.preScoreCp ?? 0) : (row?.postScoreCp ?? 0);
  const percent = 100 / (1 + Math.exp(-0.004 * cp));
  $("evalBarFill").style.height = `${Math.max(2, Math.min(98, percent))}%`;
  $("copyFenBtn").onclick = () => navigator.clipboard?.writeText(positions[cursor]).then(() => { $("loadStatus").textContent = "FEN copiado para a área de transferência."; }).catch(() => { $("loadStatus").textContent = positions[cursor]; });
  document.querySelectorAll(".move-cell").forEach(x => x.classList.remove("active"));
  const active = document.querySelector(`[data-ply="${cursor - 1}"]`);
  if (active) active.classList.add("active");
}

function showMoves() {
  const list = $("moveList");
  list.innerHTML = "";

  if (!sanMoves.length) {
    list.innerHTML = '<div class="empty">Sua partida aparecerá aqui. Você também pode mover as peças no tabuleiro.</div>';
    $("moveCount").textContent = "0 lances";
    return;
  }

  for (let i = 0; i < sanMoves.length; i += 2) {
    const row = document.createElement("div");
    row.className = "move-row";

    const number = document.createElement("span");
    number.className = "move-no";
    number.textContent = `${Math.floor(i / 2) + 1}.`;

    row.append(number);

    for (let j = i; j < Math.min(i + 2, sanMoves.length); j++) {
      const cell = document.createElement("span");

      cell.className = "move-cell";
      cell.dataset.ply = j;
      cell.textContent = sanMoves[j];

      cell.onclick = () => {
        cursor = j + 1;
        render();
      };

      const tag = analysis[j]?.label;

      if (tag) {
        const badge = document.createElement("b");
        badge.className = `tag ${tag.css}`;
        badge.textContent = tag.symbol;
        cell.append(badge);
      }

      row.append(cell);
    }

    list.append(row);
  }
  $("moveCount").textContent = `${sanMoves.length} lances`;
  const counts = {};
  for (const item of analysis) if (item.label) counts[item.label.name] = (counts[item.label.name] || 0) + 1;
  const summary = $("classificationSummary");
  if (summary) {
    summary.innerHTML = Object.entries(counts).length
      ? Object.entries(counts).map(([name, count]) => `<span class="class-count">${name}<b>${count}</b></span>`).join("")
      : '<span class="empty">Aguardando análise.</span>';
  }
}

// =========================
// IMPORTAÇÃO PGN
// =========================

function loadPgn(text) {
  try {
    game = new Chess();
    game.loadPgn(text);

    const headers = game.getHeaders();
    const history = game.history();
    const startFen = headers.SetUp === "1" && headers.FEN ? headers.FEN : new Chess().fen();
    const replay = new Chess(startFen);

    positions = [replay.fen()];
    sanMoves = [];

    for (const san of history) {
      const move = replay.move(san);

      if (!move) {
        throw new Error("Lance inválido: " + san);
      }

      sanMoves.push(move.san);
      positions.push(replay.fen());
    }

    analysis = [];
    cursor = 0;

    $("moveCount").textContent = `${history.length} lances`;
    $("whitePlayer").textContent = headers.White || "Brancas";
    $("blackPlayer").textContent = headers.Black || "Pretas";
    $("whiteMeta").textContent = headers.WhiteElo ? `Elo ${headers.WhiteElo}` : "Jogador";
    $("blackMeta").textContent = headers.BlackElo ? `Elo ${headers.BlackElo}` : "Jogador";
    $("loadStatus").textContent =
      `PGN carregado: ${history.length} lances.`;

    $("analyzeBtn").disabled =
      !history.length || !engineReady;

    $("accuracyWhite").textContent = "—";
    $("accuracyBlack").textContent = "—";
    $("accuracyWhiteSmall").textContent = "—";
    $("accuracyBlackSmall").textContent = "—";
    $("whiteAccuracyBar").style.width = "0%";
    $("blackAccuracyBar").style.width = "0%";
    $("classificationSummary").innerHTML = '<span class="empty">Aguardando análise.</span>';
    $("progressBar").style.width = "0%";

    showMoves();
    render();

    $("analysisStatus").textContent =
      engineReady
        ? "Pronto para analisar."
        : "PGN carregado. Aguardando Stockfish.";

  } catch (e) {
    $("loadStatus").textContent =
      "Não consegui ler o PGN: " + e.message;
  }
}

$("loadBtn").onclick = () => {
  loadPgn($("pgnInput").value);
};

$("pgnFile").onchange = async e => {
  const file = e.target.files[0];

  if (file) {
    const text = await file.text();
    $("pgnInput").value = text;
    loadPgn(text);
  }
};

$("prevBtn").onclick = () => {
  cursor = Math.max(0, cursor - 1);
  render();
};

$("nextBtn").onclick = () => {
  cursor = Math.min(sanMoves.length, cursor + 1);
  render();
};

$("firstBtn").onclick = () => { cursor = 0; selectedSquare = null; render(); };
$("lastBtn").onclick = () => { cursor = sanMoves.length; selectedSquare = null; render(); };

function loadFen(text) {
  try {
    const candidate = new Chess(text.trim());
    game = candidate;
    positions = [candidate.fen()];
    sanMoves = [];
    analysis = [];
    cursor = 0;
    selectedSquare = null;
    $("moveCount").textContent = "0 lances";
    $("whitePlayer").textContent = "Brancas";
    $("blackPlayer").textContent = "Pretas";
    $("whiteMeta").textContent = "Posição FEN";
    $("blackMeta").textContent = "Posição FEN";
    $("accuracyWhite").textContent = "—";
    $("accuracyBlack").textContent = "—";
    $("accuracyWhiteSmall").textContent = "—";
    $("accuracyBlackSmall").textContent = "—";
    $("whiteAccuracyBar").style.width = "0%";
    $("blackAccuracyBar").style.width = "0%";
    $("classificationSummary").innerHTML = '<span class="empty">Faça alguns lances e inicie a análise.</span>';
    $("progressBar").style.width = "0%";
    $("loadStatus").textContent = "Posição FEN carregada. Você pode mover as peças no tabuleiro.";
    $("analyzeBtn").disabled = true;
    $("analysisStatus").textContent = "Faça lances no tabuleiro para analisar a posição.";
    showMoves(); render();
  } catch (error) {
    $("loadStatus").textContent = `FEN inválida: ${error.message}`;
  }
}

$("loadFenBtn").onclick = () => loadFen($("fenInput").value);
$("startPositionBtn").onclick = () => { $("fenInput").value = new Chess().fen(); loadFen($("fenInput").value); };
$("resetBoardBtn").onclick = () => { $("fenInput").value = new Chess().fen(); loadFen($("fenInput").value); document.querySelector('[data-source="fen"]').click(); };
function flipBoard() {
  boardFlipped = !boardFlipped;
  const files = boardFlipped ? ["h","g","f","e","d","c","b","a"] : ["a","b","c","d","e","f","g","h"];
  const ranks = boardFlipped ? ["1","2","3","4","5","6","7","8"] : ["8","7","6","5","4","3","2","1"];
  document.querySelectorAll(".files-top span, .files-bottom span").forEach((node, index) => { node.textContent = files[index % 8]; });
  document.querySelectorAll(".ranks-left span").forEach((node, index) => { node.textContent = ranks[index]; });
  render();
}
$("flipBoardBtn").onclick = flipBoard;
$("flipBoardSmallBtn").onclick = flipBoard;

document.querySelectorAll(".source-tab").forEach(button => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".source-tab").forEach(tab => tab.classList.toggle("active", tab === button));
    $("pgnSource").hidden = button.dataset.source !== "pgn";
    $("fenSource").hidden = button.dataset.source !== "fen";
  });
});

$("stopBtn").onclick = () => {
  if (worker && busy) {
    stopRequested = true;
    try { worker.postMessage("stop"); } catch {}
    $("analysisStatus").textContent = "Interrompendo a análise…";
  }
};

$("analysisDepth").addEventListener("change", () => {
  $("engineDepthLabel").textContent = `Depth ${Number($("analysisDepth").value) || 12}`;
});

// =========================
// STOCKFISH 19 — carregamento hospedado ou por arquivos locais
// =========================

let engineInitTimeout = null;
let engineCleanup = null;
let engineSource = "";

function stopEngine() {
  clearTimeout(engineInitTimeout);
  clearTimeout(searchTimeout);

  if (rejectSearch) {
    rejectSearch(new Error("Análise interrompida porque o motor foi substituído."));
    resolveSearch = null;
    rejectSearch = null;
  }

  if (worker) {
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
    worker = null;
  }

  if (engineCleanup) {
    engineCleanup();
    engineCleanup = null;
  }

  engineReady = false;
  currentScore = null;
  currentDepth = 0;
}

function failEngine(message, error = null) {
  console.error("Stockfish:", error || message);
  clearTimeout(engineInitTimeout);
  clearTimeout(searchTimeout);
  if (rejectSearch) {
    const reject = rejectSearch;
    resolveSearch = null;
    rejectSearch = null;
    reject(new Error(message));
  }

  if (worker) {
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
    worker = null;
  }

  if (engineCleanup) {
    engineCleanup();
    engineCleanup = null;
  }

  engineReady = false;
  setEngine("Stockfish · indisponível");
  $("analyzeBtn").disabled = true;
  $("analysisStatus").textContent = message;
}

function launchWorker(workerUrl, cleanup = null, sourceLabel = "Stockfish 19") {
  stopEngine();
  engineCleanup = cleanup;
  engineSource = sourceLabel;
  setEngine("Stockfish · carregando");
  $("analysisStatus").textContent = "Iniciando o motor e aguardando confirmação UCI…";

  try {
    worker = new Worker(workerUrl);
  } catch (error) {
    failEngine("O navegador não conseguiu criar o Worker. Verifique se o arquivo JavaScript é uma distribuição Stockfish.js para navegador.", error);
    return;
  }

  worker.onmessage = event => {
    const line = String(event.data);

    if (line === "uciok") {
      worker.postMessage("isready");
      return;
    }

    if (line === "readyok") {
      clearTimeout(engineInitTimeout);
      engineReady = true;
      setEngine(`${engineSource} · pronto`, true);
      $("analyzeBtn").disabled = !sanMoves.length || busy;
      $("analysisStatus").textContent = "Motor inicializado e pronto para analisar.";
      return;
    }

    if (line.startsWith("info ") && line.includes(" score ")) {
      const scoreMatch = line.match(/score (cp|mate) (-?\d+)/);
      if (scoreMatch) {
        currentScore = { type: scoreMatch[1], value: Number(scoreMatch[2]) };
      }

      const depthMatch = line.match(/\bdepth (\d+)/);
      if (depthMatch) currentDepth = Number(depthMatch[1]);
    }

    if (line.startsWith("bestmove")) {
      clearTimeout(searchTimeout);
      const result = {
        score: currentScore,
        depth: currentDepth,
        best: line.split(/\s+/)[1]
      };

      if (resolveSearch) {
        const resolve = resolveSearch;
        resolveSearch = null;
        rejectSearch = null;
        resolve(result);
      }
    }
  };

  worker.onerror = event => {
    const detail = event.message || "Erro desconhecido no Worker.";
    failEngine(`Falha ao executar Stockfish: ${detail}. Confira se os arquivos JS e WASM pertencem à mesma distribuição.`, event);
  };

  engineInitTimeout = setTimeout(() => {
    failEngine("O Stockfish não confirmou a inicialização em 45 segundos. Verifique a compatibilidade dos arquivos e o caminho do WASM.");
  }, 45000);

  worker.postMessage("uci");
}

async function validateEngineFiles(files) {
  const jsFiles = files.filter(file => /\.js$/i.test(file.name));
  const wasmFiles = files.filter(file => /\.wasm$/i.test(file.name));

  if (files.length !== 2 || jsFiles.length !== 1 || wasmFiles.length !== 1) {
    throw new Error("Selecione exatamente dois arquivos: um Stockfish.js e o arquivo .wasm correspondente.");
  }

  const jsFile = jsFiles[0];
  const wasmFile = wasmFiles[0];
  const jsText = await jsFile.text();
  const wasmBytes = await wasmFile.arrayBuffer();
  const header = new Uint8Array(wasmBytes.slice(0, 8));
  const wasmMagic = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

  if (!wasmMagic.every((byte, index) => header[index] === byte)) {
    throw new Error("O arquivo selecionado não possui uma assinatura WebAssembly válida.");
  }

  if (!/Stockfish/i.test(jsText.slice(0, 1200)) || !jsText.includes("locateFile")) {
    throw new Error("O JavaScript selecionado não parece ser uma distribuição Stockfish.js compatível com navegador.");
  }

  const expectedSize = jsText.match(/var\s+a\s*=\s*(\d{5,})/);
  if (expectedSize && Number(expectedSize[1]) !== wasmFile.size) {
    throw new Error(`WASM incompatível: o JavaScript espera ${Number(expectedSize[1]).toLocaleString("pt-BR")} bytes, mas o arquivo selecionado tem ${wasmFile.size.toLocaleString("pt-BR")} bytes.`);
  }

  try {
    await WebAssembly.compile(wasmBytes.slice(0));
  } catch (error) {
    throw new Error(`O navegador não conseguiu compilar o WASM selecionado: ${error.message}`);
  }

  const multithreaded = jsText.includes("SharedArrayBuffer");
  if (multithreaded && !globalThis.crossOriginIsolated) {
    throw new Error("Esta distribuição é multithreaded e exige cross-origin isolation (SharedArrayBuffer). GitHub Pages não oferece os cabeçalhos necessários. Selecione a versão Lite Single-Threaded do Stockfish.js.");
  }

  return { jsText, wasmBytes, jsFile, wasmFile, multithreaded };
}

async function loadLocalEngine(files) {
  if (busy) {
    throw new Error("Aguarde o término da análise antes de substituir o motor.");
  }

  setEngine("Stockfish · validando");
  $("analysisStatus").textContent = "Validando os arquivos selecionados…";

  const validated = await validateEngineFiles(files);
  stopEngine();

  const wasmBlob = new Blob([validated.wasmBytes], { type: "application/wasm" });
  const wasmUrl = URL.createObjectURL(wasmBlob);
  const jsBlob = new Blob([validated.jsText], { type: "text/javascript" });
  const jsUrl = URL.createObjectURL(jsBlob);
  const workerUrl = new URL(jsUrl);
  workerUrl.hash = encodeURIComponent(wasmUrl);

  const cleanup = () => {
    URL.revokeObjectURL(jsUrl);
    URL.revokeObjectURL(wasmUrl);
  };

  launchWorker(workerUrl.href, cleanup, "Stockfish local");
}

function startBundledEngine() {
  const scriptUrl = new URL("./stockfish-19-lite.js", import.meta.url);
  const wasmUrl = new URL("./stockfish.wasm", import.meta.url).href;

  if (!globalThis.crossOriginIsolated) {
    setEngine("Stockfish · requer versão single-threaded");
    $("analysisStatus").textContent = "O motor incluído é multithreaded e precisa de SharedArrayBuffer. No GitHub Pages, use “Adicionar Stockfish” e selecione os dois arquivos da distribuição Lite Single-Threaded.";
    return;
  }

  scriptUrl.hash = encodeURIComponent(wasmUrl);
  launchWorker(scriptUrl.href, null, "Stockfish 19");
}

$("addEngineBtn").onclick = () => $("engineFiles").click();

$("engineFiles").onchange = async event => {
  const files = Array.from(event.target.files || []);
  if (!files.length) return;

  try {
    await loadLocalEngine(files);
  } catch (error) {
    console.error(error);
    if (engineReady) {
      setEngine(`${engineSource} · pronto`, true);
      $("analysisStatus").textContent = `Arquivos não carregados: ${error.message} O motor anterior continua ativo.`;
    } else {
      setEngine("Stockfish · indisponível");
      $("analysisStatus").textContent = error.message;
    }
  } finally {
    event.target.value = "";
  }
};

// =========================
// BUSCA DO MOTOR
// =========================

function search(fen, depth = 12) {
  return new Promise((resolve, reject) => {
    if (!worker || !engineReady) {
      reject(new Error("Stockfish não está pronto."));
      return;
    }

    if (resolveSearch) {
      reject(new Error("Já existe uma busca do Stockfish em andamento."));
      return;
    }
    clearTimeout(searchTimeout);

    currentScore = null;
    currentDepth = 0;

    resolveSearch = resolve;
    rejectSearch = reject;

    try {
      worker.postMessage("position fen " + fen);
      worker.postMessage("go depth " + depth);
    } catch (error) {
      resolveSearch = null;
      rejectSearch = null;
      reject(new Error("Não foi possível enviar a posição ao Stockfish: " + error.message));
      return;
    }

    searchTimeout = setTimeout(() => {
      if (rejectSearch) {
        const reject = rejectSearch;
        rejectSearch = null;
        resolveSearch = null;
        const message = "O Stockfish excedeu 90 segundos nesta posição. Reduza a profundidade ou verifique os arquivos do motor.";
        reject(new Error(message));
        failEngine(message);
      }
    }, 90000);
  });
}

// =========================
// AVALIAÇÃO
// =========================

function scoreToNumber(score) {
  if (!score) return 0;

  if (score.type === "mate") {
    return Math.sign(score.value) *
      (100000 - Math.abs(score.value) * 100);
  }

  return score.value;
}

function scoreForWhite(score, turn) {
  const value = scoreToNumber(score);

  return turn === "w" ? value : -value;
}

function formatScore(score, turn) {
  if (!score) return "—";

  if (score.type === "mate") {
    const value =
      turn === "w" ? score.value : -score.value;

    return `#${value}`;
  }

  const pawns = scoreForWhite(score, turn) / 100;
  if (Math.abs(pawns) < 0.005) return "0.00";
  return `${pawns > 0 ? "+" : "−"}${Math.abs(pawns).toFixed(2)}`;
}

// Converte centipawns em expectativa de resultado (0–100%).
// É uma aproximação didática, não a fórmula CAPS2 do Chess.com.
function expectedScorePercent(centipawns) {
  return 100 / (1 + Math.exp(-0.004 * centipawns));
}

function accuracyFromExpectedLosses(moves) {
  if (!moves.length) return "—";
  // Estimativa própria: média da perda de expectativa de resultado por lance.
  // O CAPS2 do Chess.com não é público; não é possível reproduzir seus números exatos.
  const averageLoss = moves.reduce((sum, move) => sum + move.expectedLoss, 0) / moves.length;
  const estimate = 100 * Math.exp(-3.2 * averageLoss / 100);
  return `${Math.max(0, Math.min(100, estimate)).toFixed(1)}%`;
}

// =========================
// LIVRO DE ABERTURAS (linhas comuns)
// =========================
// Uma jogada só recebe "Livro" enquanto a sequência inteira da partida
// coincidir com um prefixo conhecido. A lista é deliberadamente conservadora.
const openingLines = [
  "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7",
  "e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d3",
  "e4 e5 Nf3 Nc6 d4 exd4 Nxd4",
  "e4 e5 f4 exf4 Nf3 g5",
  "e4 e5 Nc3 Nf6 f4 d5",
  "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3",
  "e4 c5 Nf3 Nc6 d4 cxd4 Nxd4",
  "e4 c5 Nc3 Nc6 g3 g6 Bg2 Bg7",
  "e4 e6 d4 d5 Nc3 Nf6 Bg5 Be7",
  "e4 e6 d4 d5 Nd2 Nf6 e5 Nfd7",
  "e4 c6 d4 d5 Nc3 dxe4 Nxe4",
  "e4 c6 d4 d5 e5 Bf5",
  "d4 d5 c4 e6 Nc3 Nf6 Bg5 Be7",
  "d4 d5 c4 e6 Nf3 Nf6 Nc3",
  "d4 d5 c4 c6 Nf3 Nf6 Nc3",
  "d4 Nf6 c4 e6 Nc3 Bb4",
  "d4 Nf6 c4 g6 Nc3 d5",
  "d4 Nf6 c4 g6 Nc3 Bg7 e4 d6",
  "d4 Nf6 Nf3 g6 c4 Bg7 Nc3 O-O",
  "Nf3 d5 g3 Nf6 Bg2 e6 O-O Be7",
  "e4 e5 Nf3 Nc6 Bb5 Nf6 O-O Nxe4",
  "e4 e5 Nf3 Nc6 Bb5 a6 Bxc6 dxc6",
  "e4 e5 Nf3 Nc6 Bc4 Nf6 d3 Be7",
  "e4 e5 Nf3 Nc6 Nc3 Nf6",
  "e4 e5 Nc3 Nf6",
  "d4 d5 c4",
  "e4 c5 Nf3 e6 d4 cxd4 Nxd4 a6",
  "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6"
];

function normalizeSan(san) {
  return san.replace(/[+#?!]+/g, "").replace(/0-0-0/g, "O-O-O").replace(/0-0/g, "O-O");
}

const openingPrefixes = new Set();
for (const line of openingLines) {
  const moves = line.split(/\s+/).map(normalizeSan);
  for (let i = 1; i <= moves.length; i++) {
    openingPrefixes.add(moves.slice(0, i).join(" "));
  }
}

function isBookMove(plyIndex) {
  const prefix = sanMoves.slice(0, plyIndex + 1).map(normalizeSan).join(" ");
  return openingPrefixes.has(prefix);
}

const pieceValue = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
function isBestMoveSacrifice(fen, playedMove, bestUci) {
  if (!playedMove || !bestUci) return false;
  const playedUci = playedMove.from + playedMove.to + (playedMove.promotion || "");
  if (playedUci.slice(0, 4) !== bestUci.slice(0, 4)) return false;
  if (playedMove.captured || playedMove.promotion) return false;
  try {
    const position = new Chess(fen);
    const mover = playedMove.color;
    const movedPiece = playedMove.piece;
    position.move({ from: playedMove.from, to: playedMove.to, promotion: playedMove.promotion || "q" });
    const captures = position.moves({ verbose: true }).filter(m => m.to === playedMove.to && m.captured);
    return captures.some(m => pieceValue[movedPiece] > pieceValue[m.captured]);
  } catch {
    return false;
  }
}

// =========================
// CLASSIFICAÇÕES
// =========================

function labelMove(loss, move, context = {}) {
  if (context.book) {
    return { name: "Livro", symbol: "📖", css: "c-book" };
  }

  if (loss <= 10 && isBestMoveSacrifice(context.fen, move, context.bestMove)) {
    return { name: "Brilhante", symbol: "!!", css: "c-brilliant" };
  }

  if (loss <= 5) {
    return {
      name: "Melhor",
      symbol: "★",
      css: "c-best"
    };
  }

  if (loss <= 18) {
    return {
      name: "Excelente",
      symbol: "!",
      css: "c-excellent"
    };
  }

  if (loss <= 45) {
    if (move.san.includes("+") || move.san.includes("#")) {
      return {
        name: "Traiçoeiro",
        symbol: "!?",
        css: "c-tricky"
      };
    }

    return {
      name: "Bom",
      symbol: "✓",
      css: "c-good"
    };
  }

  if (loss <= 90) {
    return {
      name: "Imprecisão",
      symbol: "?!",
      css: "c-inaccuracy"
    };
  }

  if (loss <= 180) {
    return {
      name: "Erro",
      symbol: "?",
      css: "c-mistake"
    };
  }

  return {
    name: "Erro grave",
    symbol: "??",
    css: "c-blunder"
  };
}

// =========================
// ANÁLISE DA PARTIDA
// =========================

$("analyzeBtn").onclick = async () => {
  if (
    !engineReady ||
    busy ||
    !positions.length ||
    !sanMoves.length
  ) {
    return;
  }

  busy = true;
  stopRequested = false;
  $("analyzeBtn").disabled = true;
  $("stopBtn").disabled = false;

  analysis = [];

  setEngine("Stockfish 19 · analisando", true);

  const depth = Number($("analysisDepth").value) || 12;
  const total = sanMoves.length;

  try {
    for (let i = 0; i < total; i++) {
      if (stopRequested) throw new Error("Análise interrompida pelo usuário.");
      const before = new Chess(positions[i]);
      const after = new Chess(positions[i + 1]);

      const moveColor = before.turn();

      const pre = await search(positions[i], depth);
      if (stopRequested) throw new Error("Análise interrompida pelo usuário.");
      const post = await search(positions[i + 1], depth);
      if (stopRequested) throw new Error("Análise interrompida pelo usuário.");

      const preWhite =
        scoreForWhite(pre.score, before.turn());

      const postWhite =
        scoreForWhite(post.score, after.turn());

      const loss = Math.max(
        0,
        moveColor === "w"
          ? preWhite - postWhite
          : postWhite - preWhite
      );

      const preForMover = moveColor === "w" ? preWhite : -preWhite;
      const postForMover = moveColor === "w" ? postWhite : -postWhite;
      const expectedLoss = Math.max(
        0,
        expectedScorePercent(preForMover) - expectedScorePercent(postForMover)
      );

      const replay = new Chess(positions[i]);
      const playedMove = replay.move(sanMoves[i]);

      const label = labelMove(loss, playedMove, {
        fen: positions[i],
        bestMove: pre.best,
        book: isBookMove(i)
      });

      const scoreText = formatScore(post.score, after.turn());

      analysis.push({
        loss,
        expectedLoss,
        color: moveColor,
        label,
        scoreText,
        preScoreText: formatScore(pre.score, before.turn()),
        preScoreCp: preWhite,
        postScoreCp: postWhite,
        bestMove: pre.best,
        nextBestMove: post.best,
        depth
      });

      $("analysisStatus").textContent =
        `Analisando ${i + 1} de ${total} · profundidade ${depth}`;

      $("progressBar").style.width =
        `${((i + 1) / total) * 100}%`;

      showMoves();
      render();
    }

    const whiteMoves = analysis.filter(move => move.color === "w");
    const blackMoves = analysis.filter(move => move.color === "b");

    const whiteAccuracy = accuracyFromExpectedLosses(whiteMoves);
    const blackAccuracy = accuracyFromExpectedLosses(blackMoves);
    $("accuracyWhite").textContent = whiteAccuracy;
    $("accuracyBlack").textContent = blackAccuracy;
    $("accuracyWhiteSmall").textContent = whiteAccuracy;
    $("accuracyBlackSmall").textContent = blackAccuracy;
    $("whiteAccuracyBar").style.width = whiteAccuracy;
    $("blackAccuracyBar").style.width = blackAccuracy;

    $("analysisStatus").textContent =
      "Análise concluída. Toque em um lance para ver sua classificação.";

    setEngine("Stockfish 19 · concluído", true);

    showMoves();
    render();

  } catch (e) {
    console.error(e);
    $("analysisStatus").textContent = "Erro durante a análise: " + e.message;
    if (engineReady) setEngine(`${engineSource} · pronto`, true);
  }

  busy = false;
  stopRequested = false;
  $("stopBtn").disabled = true;
  $("analyzeBtn").disabled = !sanMoves.length || !engineReady;
};

// =========================
// INICIALIZAÇÃO
// =========================

positions = [new Chess().fen()];
render();
startBundledEngine();

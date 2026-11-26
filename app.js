
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

let evals = [];
let currentLines = {};
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
    evals = evals.slice(0, cursor + 1);
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

function pvToSan(fen, pv, n = 5) {
  try {
    const g = new Chess(fen);
    const out = [];
    for (const u of (pv || []).slice(0, n)) {
      const m = g.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
      if (!m) break;
      out.push(m.san);
    }
    return out.join(" ");
  } catch { return ""; }
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
  const ev = evals[cursor];
  const positionBest = ev?.best;
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
  const turnCode = new Chess(positions[cursor]).turn();
  const l1 = ev?.lines?.[0], l2 = ev?.lines?.[1];
  $("engineLineMove").textContent = (l1 && pvToSan(positions[cursor], l1.pv)) || bestSan || "—";
  $("engineLine2Move").textContent = (l2 && pvToSan(positions[cursor], l2.pv)) || "—";
  $("engineLine2Eval").textContent = l2 ? formatScore(l2.score, turnCode) : "—";
  $("engineLineEval").textContent = scoreText;
  $("engineLineDepth").textContent = ev?.terminal ? "Fim de partida" : (positionBest ? `Profundidade ${ev?.depth || 0}` : "Aguardando análise");
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
    evals = [];
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
    evals = [];
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
      worker.postMessage("setoption name MultiPV value 2");
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
      // Ignora linhas parciais (aspiration window): não são avaliações confiáveis.
      if (/\b(lowerbound|upperbound)\b/.test(line)) return;
      const sm = line.match(/score (cp|mate) (-?\d+)/);
      if (!sm) return;
      const dm = line.match(/\bdepth (\d+)/);
      const mm = line.match(/\bmultipv (\d+)/);
      const pm = line.match(/ pv (.+)$/);
      const idx = mm ? Number(mm[1]) : 1;
      currentLines[idx] = {
        score: { type: sm[1], value: Number(sm[2]) },
        depth: dm ? Number(dm[1]) : 0,
        pv: pm ? pm[1].trim().split(/\s+/) : []
      };
      return;
    }

    if (line.startsWith("bestmove")) {
      clearTimeout(searchTimeout);
      const lines = Object.keys(currentLines).map(Number).sort((a, b) => a - b).map(k => currentLines[k]);
      const best = line.split(/\s+/)[1];
      const result = {
        lines,
        score: lines[0]?.score || null,
        depth: lines[0]?.depth || 0,
        best: best === "(none)" ? null : best
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
  // Build single-threaded: não usa SharedArrayBuffer, funciona no GitHub Pages.
  // O JS localiza o .wasm de mesmo nome na mesma pasta (stockfish-19-lite-single.wasm).
  const scriptUrl = new URL("./stockfish-19-lite-single.js", import.meta.url);
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
    currentLines = {};

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

const MATE_CP = 100000;

function scoreToNumber(score) {
  if (!score) return 0;
  if (score.type === "mate") return Math.sign(score.value) * (MATE_CP - Math.abs(score.value) * 100);
  return score.value;
}

function scoreForWhite(score, turn) {
  const value = scoreToNumber(score);
  return turn === "w" ? value : -value;
}

function formatScore(score, turn) {
  if (!score) return "—";
  if (score.type === "mate") {
    const value = turn === "w" ? score.value : -score.value;
    return `#${value}`;
  }
  const pawns = scoreForWhite(score, turn) / 100;
  if (Math.abs(pawns) < 0.005) return "0.00";
  return `${pawns > 0 ? "+" : "−"}${Math.abs(pawns).toFixed(2)}`;
}

// Chance de vitória (0–100) para quem tem a vez, a partir da nota do motor.
// Modelo logístico do Lichess; mate vale 100 ou 0.
function winPercent(score) {
  if (!score) return 50;
  if (score.type === "mate") return score.value > 0 ? 100 : 0;
  const cp = Math.max(-1000, Math.min(1000, score.value));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

// Precisão de um lance a partir da perda de chance de vitória (fórmula do projeto).
function moveAccuracy(winLoss) {
  const v = 103.1668 * Math.exp(-0.04354 * winLoss) - 3.1669;
  return Math.max(0, Math.min(100, v));
}

function accuracyFromMoves(moves) {
  if (!moves.length) return "—";
  const mean = moves.reduce((sum, m) => sum + m.accuracy, 0) / moves.length;
  return `${mean.toFixed(1)}%`;
}

// Avalia uma posição (ou reconhece fim de partida sem consultar o motor).
async function evaluate(index, depth) {
  const fen = positions[index];
  const g = new Chess(fen);
  const turn = g.turn();
  if (g.isCheckmate()) {
    return { turn, terminal: "mate", lines: [], best: null, depth: 0,
      scoreText: turn === "w" ? "0-1" : "1-0", whiteCp: turn === "w" ? -MATE_CP : MATE_CP };
  }
  if (g.isDraw()) {
    return { turn, terminal: "draw", lines: [], best: null, depth: 0, scoreText: "½-½", whiteCp: 0 };
  }
  const r = await search(fen, depth);
  return { turn, terminal: null, lines: r.lines, best: r.best, depth: r.depth || depth,
    scoreText: formatScore(r.score, turn), whiteCp: scoreForWhite(r.score, turn) };
}

// Chance de vitória de `color` na posição avaliada (linha k do motor).
function winFor(ev, color, k = 0) {
  if (ev.terminal === "mate") return ev.turn === color ? 0 : 100;
  if (ev.terminal === "draw") return 50;
  const line = ev.lines[k];
  if (!line) return 50;
  const w = winPercent(line.score);
  return ev.turn === color ? w : 100 - w;
}

// =========================
// LIVRO DE ABERTURAS (por posição, aceita transposições)
// =========================
const openingLines = [
  "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7",
  "e4 e5 Nf3 Nc6 Bb5 Nf6 O-O Nxe4",
  "e4 e5 Nf3 Nc6 Bb5 a6 Bxc6 dxc6",
  "e4 e5 Nf3 Nc6 Bb5 Nf6 d3",
  "e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d3",
  "e4 e5 Nf3 Nc6 Bc4 Nf6 d3 Be7",
  "e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 d5 exd5 Na5",
  "e4 e5 Nf3 Nc6 d4 exd4 Nxd4",
  "e4 e5 Nf3 Nc6 d4 exd4 Bc4",
  "e4 e5 Nf3 Nc6 Nc3 Nf6",
  "e4 e5 Nf3 Nf6 Nxe5 d6 Nf3 Nxe4 d4 d5",
  "e4 e5 Nf3 d6 d4 exd4 Nxd4 Nf6 Nc3",
  "e4 e5 f4 exf4 Nf3 g5",
  "e4 e5 Nc3 Nf6 f4 d5",
  "e4 e5 Nc3 Nf6",
  "e4 e5 Bc4 Nf6 d3",
  "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6",
  "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 g6",
  "e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 Nf6 Nc3 e5",
  "e4 c5 Nf3 e6 d4 cxd4 Nxd4 a6",
  "e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nc6 Nc3 Qc7",
  "e4 c5 Nc3 Nc6 g3 g6 Bg2 Bg7",
  "e4 c5 c3 d5 exd5 Qxd5 d4 Nf6",
  "e4 e6 d4 d5 Nc3 Nf6 Bg5 Be7",
  "e4 e6 d4 d5 Nc3 Bb4 e5 c5",
  "e4 e6 d4 d5 Nd2 Nf6 e5 Nfd7",
  "e4 e6 d4 d5 e5 c5 c3 Nc6",
  "e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5",
  "e4 c6 d4 d5 e5 Bf5 Nf3 e6",
  "e4 d5 exd5 Qxd5 Nc3 Qa5",
  "e4 d5 exd5 Nf6 d4 Nxd5",
  "e4 d6 d4 Nf6 Nc3 g6 f4 Bg7 Nf3",
  "e4 g6 d4 Bg7 Nc3 d6",
  "d4 d5 c4 e6 Nc3 Nf6 Bg5 Be7 e3 O-O",
  "d4 d5 c4 e6 Nf3 Nf6 Nc3 Be7",
  "d4 d5 c4 c6 Nf3 Nf6 Nc3 dxc4",
  "d4 d5 c4 dxc4 Nf3 Nf6 e3 e6 Bxc4 c5",
  "d4 d5 Bf4 Nf6 e3 e6 Nf3 Bd6",
  "d4 d5 Nf3 Nf6 c4 e6 Nc3",
  "d4 Nf6 c4 e6 Nc3 Bb4 e3 O-O",
  "d4 Nf6 c4 e6 Nf3 b6 g3 Bb7 Bg2 Be7",
  "d4 Nf6 c4 g6 Nc3 d5 cxd5 Nxd5 e4 Nxc3 bxc3 Bg7",
  "d4 Nf6 c4 g6 Nc3 Bg7 e4 d6 Nf3 O-O Be2 e5",
  "d4 Nf6 Nf3 g6 c4 Bg7 Nc3 O-O",
  "d4 Nf6 Bg5 Ne4 Bf4 c5",
  "d4 Nf6 c4 c5 d5 b5",
  "c4 e5 Nc3 Nf6 Nf3 Nc6 g3 d5 cxd5 Nxd5",
  "c4 c5 Nf3 Nf6 Nc3 Nc6 g3 g6 Bg2 Bg7",
  "c4 Nf6 Nc3 e6 e4 d5 e5 d4",
  "Nf3 d5 g3 Nf6 Bg2 e6 O-O Be7",
  "Nf3 d5 c4 e6 g3 Nf6 Bg2 Be7 O-O O-O",
  "Nf3 Nf6 c4 g6 Nc3 Bg7 e4 d6 d4 O-O",
  "Nf3 Nf6 g3 g6 Bg2 Bg7 O-O O-O d3 d6"
];

const stripFen = fen => fen.split(" ").slice(0, 4).join(" ");
const bookKeys = new Set();
for (const line of openingLines) {
  try {
    const g = new Chess();
    for (const san of line.split(/\s+/)) {
      if (!g.move(san)) break;
      bookKeys.add(stripFen(g.fen()));
    }
  } catch { /* linha ilegal é ignorada */ }
}
const startKey = stripFen(new Chess().fen());

// =========================
// MATERIAL / SACRIFÍCIO
// =========================
const pieceValue = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

function materialBalance(chess, color) {
  let sum = 0;
  for (const row of chess.board()) {
    for (const p of row) {
      if (p) sum += (p.color === color ? 1 : -1) * pieceValue[p.type];
    }
  }
  return sum;
}

// Sacrifício = ao seguir a linha principal do motor (até 8 lances, terminando
// numa resposta do adversário), quem joga fica com ao menos 2 pontos de material a menos.
function isSacrifice(fen, uci, pv) {
  try {
    if (!pv || pv[0] !== uci) return false;
    let n = Math.min(pv.length, 8);
    if (n % 2 === 1) n--;
    if (n < 4) return false;
    const g = new Chess(fen);
    const color = g.turn();
    const before = materialBalance(g, color);
    for (let k = 0; k < n; k++) {
      const m = g.move({ from: pv[k].slice(0, 2), to: pv[k].slice(2, 4), promotion: pv[k][4] });
      if (!m) return false;
    }
    if (g.isCheckmate()) return false;
    return before - materialBalance(g, color) >= 2;
  } catch {
    return false;
  }
}

// =========================
// CLASSIFICAÇÕES (perda de chance de vitória, em pontos percentuais)
// =========================
const LABELS = {
  book:        { name: "Livro",      symbol: "📖", css: "c-book" },
  brilliant:   { name: "Brilhante",  symbol: "!!", css: "c-brilliant" },
  tricky:      { name: "Traiçoeiro", symbol: "!?", css: "c-tricky" },
  best:        { name: "Melhor",     symbol: "★",  css: "c-best" },
  excellent:   { name: "Excelente",  symbol: "!",  css: "c-excellent" },
  good:        { name: "Bom",        symbol: "✓",  css: "c-good" },
  inaccuracy:  { name: "Imprecisão", symbol: "?!", css: "c-inaccuracy" },
  mistake:     { name: "Erro",       symbol: "?",  css: "c-mistake" },
  blunder:     { name: "Erro grave", symbol: "??", css: "c-blunder" }
};

function labelMove({ loss, isBest, book, brilliant, tricky }) {
  if (book) return LABELS.book;
  if (brilliant) return LABELS.brilliant;
  if (tricky) return LABELS.tricky;
  if (isBest || loss <= 0.5) return LABELS.best;
  if (loss <= 2) return LABELS.excellent;
  if (loss <= 5) return LABELS.good;
  if (loss <= 10) return LABELS.inaccuracy;
  if (loss <= 20) return LABELS.mistake;
  return LABELS.blunder;
}

// =========================
// ANÁLISE DA PARTIDA
// =========================

$("analyzeBtn").onclick = async () => {
  if (!engineReady || busy || !positions.length || !sanMoves.length) return;

  busy = true;
  stopRequested = false;
  $("analyzeBtn").disabled = true;
  $("stopBtn").disabled = false;

  analysis = [];
  evals = [];
  setEngine("Stockfish 19 · analisando", true);

  const depth = Number($("analysisDepth").value) || 16;
  const total = sanMoves.length;
  const checkStop = () => { if (stopRequested) throw new Error("Análise interrompida pelo usuário."); };

  try {
    // N+1 buscas: a avaliação posterior de um lance é a anterior do seguinte.
    evals[0] = await evaluate(0, depth);
    let inBook = stripFen(positions[0]) === startKey;

    for (let i = 0; i < total; i++) {
      checkStop();
      evals[i + 1] = await evaluate(i + 1, depth);
      checkStop();

      const pre = evals[i];
      const post = evals[i + 1];
      const replay = new Chess(positions[i]);
      const color = replay.turn();
      const played = replay.move(sanMoves[i]);
      const playedUci = played.from + played.to + (played.promotion || "");

      const isBest = !!pre.best && playedUci === pre.best;
      const preWin = winFor(pre, color, 0);
      const postWin = winFor(post, color);
      const loss = isBest ? 0 : Math.max(0, preWin - postWin);

      inBook = inBook && bookKeys.has(stripFen(positions[i + 1]));

      // Traiçoeiro (!?): lance (quase) único que mantém a posição —
      // o 2º melhor lance do motor perde muito mais chance de vitória.
      let tricky = false;
      if (isBest && !post.terminal && pre.lines.length >= 2) {
        const gap = preWin - winFor(pre, color, 1);
        tricky = gap >= 15 && preWin >= 30 && preWin <= 95 && !played.san.includes("#");
      }

      // Brilhante (!!): lance muito bom que sacrifica material, sem posição já decidida.
      let brilliant = false;
      const match = pre.lines.find(l => l.pv[0] === playedUci);
      if (match && loss <= 2 && !post.terminal && preWin <= 85 && postWin >= 40) {
        brilliant = isSacrifice(positions[i], playedUci, match.pv);
      }

      const label = labelMove({ loss, isBest, book: inBook, brilliant, tricky });

      analysis.push({
        loss,
        expectedLoss: loss,
        accuracy: moveAccuracy(loss),
        color,
        label,
        scoreText: post.scoreText,
        preScoreText: pre.scoreText,
        preScoreCp: pre.whiteCp,
        postScoreCp: post.whiteCp,
        bestMove: pre.best,
        nextBestMove: post.best,
        depth: post.depth || depth
      });

      $("analysisStatus").textContent = `Analisando ${i + 1} de ${total} · profundidade ${depth}`;
      $("progressBar").style.width = `${((i + 1) / total) * 100}%`;
      showMoves();
      render();
    }

    const whiteAccuracy = accuracyFromMoves(analysis.filter(m => m.color === "w"));
    const blackAccuracy = accuracyFromMoves(analysis.filter(m => m.color === "b"));
    $("accuracyWhite").textContent = whiteAccuracy;
    $("accuracyBlack").textContent = blackAccuracy;
    $("accuracyWhiteSmall").textContent = whiteAccuracy;
    $("accuracyBlackSmall").textContent = blackAccuracy;
    $("whiteAccuracyBar").style.width = whiteAccuracy;
    $("blackAccuracyBar").style.width = blackAccuracy;

    $("analysisStatus").textContent = "Análise concluída. Toque em um lance para ver sua classificação.";
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

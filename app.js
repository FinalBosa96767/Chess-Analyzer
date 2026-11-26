
import { Chess } from "https://cdn.jsdelivr.net/npm/chess.js@1.4.0/+esm";

const $ = id => document.getElementById(id);

const glyph = {
  wk:"♔", wq:"♕", wr:"♖", wb:"♗", wn:"♘", wp:"♙",
  bk:"♚", bq:"♛", br:"♜", bb:"♝", bn:"♞", bp:"♟"
};

let positions = [];
let sanMoves = [];
let analysis = [];
let cursor = 0;

let worker = null;
let engineReady = false;
let busy = false;
let cancelRequested = false;
let analysisDepthUsed = null;
const searchCache = new Map();

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
      const square = document.createElement("div");
      square.className = `square ${(r + c) % 2 === 0 ? "light" : "dark"}`;

      const piece = board[r][c];
      if (piece) {
        const span = document.createElement("span");
        span.className = `piece ${piece.color === "w" ? "piece-white" : "piece-black"}`;
        span.textContent = glyph[piece.color + piece.type];
        square.append(span);
      }

      el.append(square);
    }
  }

  if (bestMove && bestMove.length >= 4 && bestMove !== "(none)") {
    const fromFile = bestMove.charCodeAt(0) - 97;
    const fromRank = Number(bestMove[1]);
    const toFile = bestMove.charCodeAt(2) - 97;
    const toRank = Number(bestMove[3]);

    if ([fromFile, toFile].every(n => n >= 0 && n < 8) &&
        [fromRank, toRank].every(n => n >= 1 && n <= 8)) {
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

      const line = document.createElementNS(svgNS, "line");
      line.setAttribute("x1", String(fromFile * 100 + 50));
      line.setAttribute("y1", String((8 - fromRank) * 100 + 50));
      line.setAttribute("x2", String(toFile * 100 + 50));
      line.setAttribute("y2", String((8 - toRank) * 100 + 50));
      line.setAttribute("stroke", "#20b879");
      line.setAttribute("stroke-width", "13");
      line.setAttribute("stroke-linecap", "round");
      line.setAttribute("opacity", "0.88");
      line.setAttribute("marker-end", "url(#best-arrow-head)");
      svg.append(line);
      el.append(svg);
    }
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

  // Cada posição recebe a melhor continuação pesquisada pelo motor:
  // a inicial vem do primeiro lance; as seguintes vêm da busca pós-lance.
  const positionBest = cursor === 0
    ? analysis[0]?.bestMove
    : analysis[cursor - 1]?.nextBestMove;
  makeBoard(positions[cursor], positionBest);

  const bestSan = bestMoveSan(positions[cursor], positionBest);
  const sideToMove = new Chess(positions[cursor]).turn() === "w" ? "brancas" : "pretas";
  $("bestMoveLabel").textContent = bestSan
    ? `Melhor para ${sideToMove}: ${bestSan}`
    : "Melhor lance: —";

  $("moveCounter").textContent =
    `${cursor} / ${sanMoves.length}`;

  $("turnLabel").textContent =
    cursor === 0
      ? "Posição inicial"
      : `Após ${cursor} ${cursor === 1 ? "lance" : "lances"}`;

  $("prevBtn").disabled = cursor === 0;
  $("nextBtn").disabled = cursor === sanMoves.length;

  const row = analysis[cursor - 1];

  $("evalLabel").textContent =
    row?.scoreText
      ? `Avaliação: ${row.scoreText}`
      : "Avaliação: —";

  document.querySelectorAll(".move-cell")
    .forEach(x => x.classList.remove("active"));

  const active = document.querySelector(
    `[data-ply="${cursor - 1}"]`
  );

  if (active) active.classList.add("active");
}

function showMoves() {
  const list = $("moveList");
  list.innerHTML = "";

  if (!sanMoves.length) {
    list.innerHTML =
      '<div class="empty">Sua partida aparecerá aqui.</div>';
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
}

// =========================
// IMPORTAÇÃO PGN
// =========================

function loadPgn(text) {
  if (busy) {
    $("loadStatus").textContent = "Pare a análise antes de carregar outra partida.";
    return;
  }
  try {
    const candidate = new Chess();
    candidate.loadPgn(text);
    const headers = candidate.getHeaders();
    const startFen = headers.FEN || new Chess().fen();
    const replay = new Chess(startFen);
    const history = candidate.history();
    const nextPositions = [replay.fen()];
    const nextMoves = [];

    for (const san of history) {
      const move = replay.move(san);
      if (!move) throw new Error("Lance inválido ao reconstruir o PGN: " + san);
      nextMoves.push(move.san);
      nextPositions.push(replay.fen());
    }

    positions = nextPositions;
    sanMoves = nextMoves;
    analysis = [];
    analysisDepthUsed = null;
    searchCache.clear();
    cursor = 0;

    $("moveCount").textContent = history.length;
    $("loadStatus").textContent = `PGN carregado: ${history.length} lances${headers.FEN ? " · posição inicial personalizada" : ""}.`;
    $("analyzeBtn").disabled = !history.length || !engineReady;
    $("accuracyWhite").textContent = "—";
    $("accuracyBlack").textContent = "—";
    $("progressBar").style.width = "0%";
    $("analysisReport").innerHTML = '<p class="empty">O relatório será montado após a análise.</p>';
    showMoves();
    render();
    $("analysisStatus").textContent = engineReady ? "Pronto para analisar." : "PGN carregado. Aguardando Stockfish.";
  } catch (e) {
    $("loadStatus").textContent = "Não consegui ler o PGN: " + e.message;
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
      $("analysisDepth").disabled = busy;
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
        searchCache.set(cacheKey, result);
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
  const cacheKey = `${depth}|${fen}`;
  if (searchCache.has(cacheKey)) return Promise.resolve(searchCache.get(cacheKey));
  return new Promise((resolve, reject) => {
    if (!worker || !engineReady) {
      reject(new Error("Stockfish não está pronto."));
      return;
    }

    clearTimeout(searchTimeout);

    currentScore = null;
    currentDepth = 0;

    resolveSearch = resolve;
    rejectSearch = reject;

    worker.postMessage("position fen " + fen);
    worker.postMessage("go depth " + depth);

    searchTimeout = setTimeout(() => {
      if (rejectSearch) {
        rejectSearch(
          new Error("Tempo limite da análise excedido.")
        );

        rejectSearch = null;
        resolveSearch = null;
        worker.postMessage("stop");
      }
    }, 60000);
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

  return (
    scoreForWhite(score, turn) / 100
  ).toFixed(2);
}

// Converte centipawns em expectativa de resultado (0–100%).
// É uma aproximação didática, não a fórmula CAPS2 do Chess.com.
function expectedScorePercent(centipawns) {
  return 100 / (1 + Math.exp(-0.004 * centipawns));
}

function accuracyFromExpectedLosses(moves) {
  if (!moves.length) return "—";
  const averageLoss = moves.reduce((sum, move) => sum + move.expectedLoss, 0) / moves.length;
  const estimate = 103.1668 * Math.exp(-0.04354 * averageLoss) - 3.1669;
  return `${Math.max(0, Math.min(100, estimate)).toFixed(1)}%`;
}

// =========================
// CLASSIFICAÇÕES
// =========================

function labelMove(loss) {
  if (loss <= 5) return { name: "Melhor", symbol: "★", css: "c-best" };
  if (loss <= 18) return { name: "Excelente", symbol: "!", css: "c-excellent" };
  if (loss <= 45) return { name: "Bom", symbol: "✓", css: "c-good" };
  if (loss <= 90) return { name: "Imprecisão", symbol: "?!", css: "c-inaccuracy" };
  if (loss <= 180) return { name: "Erro", symbol: "?", css: "c-mistake" };
  return { name: "Erro grave", symbol: "??", css: "c-blunder" };
}

function renderReport() {
  const report = $("analysisReport");
  if (!analysis.length) {
    report.innerHTML = '<p class="empty">O relatório será montado após a análise.</p>';
    return;
  }
  const ranked = analysis.map((item, ply) => ({ ...item, ply }))
    .filter(item => Number.isFinite(item.loss));
  const worst = [...ranked].sort((a, b) => b.loss - a.loss).slice(0, 3);
  const best = [...ranked].sort((a, b) => a.loss - b.loss).slice(0, 3);
  const label = item => `${Math.floor(item.ply / 2) + 1}${item.color === "w" ? "." : "..."} ${sanMoves[item.ply]}`;
  const makeRow = (title, items, suffix) => {
    const section = document.createElement("div");
    section.className = "report-stat";
    const heading = document.createElement("span");
    heading.textContent = title;
    const value = document.createElement("strong");
    value.textContent = items.length ? items.map(item => `${label(item)} (${Math.round(item.loss)} cp)`).join(" · ") : suffix;
    section.append(heading, value);
    return section;
  };
  const counts = ranked.reduce((acc, item) => {
    acc[item.label.name] = (acc[item.label.name] || 0) + 1;
    return acc;
  }, {});
  const categoryText = Object.entries(counts).map(([name, count]) => `${name}: ${count}`).join(" · ");
  const white = ranked.filter(item => item.color === "w");
  const black = ranked.filter(item => item.color === "b");
  const average = list => list.length ? `${(list.reduce((sum, item) => sum + item.loss, 0) / list.length).toFixed(1)} cp` : "—";
  report.replaceChildren(
    makeRow("Menores perdas", best, "—"),
    makeRow("Maiores perdas", worst, "—"),
    makeRow("Perda média · brancas", [], average(white)),
    makeRow("Perda média · pretas", [], average(black))
  );
  const categories = document.createElement("p");
  categories.className = "report-note";
  categories.textContent = categoryText || "Sem classificações disponíveis.";
  report.append(categories);
  const note = document.createElement("p");
  note.className = "report-note";
  note.textContent = "Perda estimada em centipawns, comparando a avaliação da posição antes e depois do lance. Valores dependem da profundidade e da versão do motor.";
  report.append(note);
}

// =========================
// ANÁLISE DA PARTIDA
// =========================

$("analyzeBtn").onclick = async () => {
  if (!engineReady || busy || !positions.length || !sanMoves.length) return;
  busy = true;
  cancelRequested = false;
  $("analyzeBtn").disabled = true;
  $("stopBtn").disabled = false;
  $("analysisDepth").disabled = true;
  setEngine("Stockfish · analisando", true);
  const depth = Number($("analysisDepth").value) || 12;
  const total = sanMoves.length;
  if (analysisDepthUsed !== depth) {
    analysis = [];
    analysisDepthUsed = depth;
    $("progressBar").style.width = "0%";
  }
  $("analysisReport").innerHTML = analysis.length
    ? '<p class="empty">Retomando a análise…</p>'
    : '<p class="empty">Análise em andamento…</p>';

  try {
    for (let i = analysis.length; i < total; i++) {
      if (cancelRequested) throw new Error("Análise interrompida pelo usuário.");
      const before = new Chess(positions[i]);
      const after = new Chess(positions[i + 1]);
      const moveColor = before.turn();
      const pre = await search(positions[i], depth);
      if (cancelRequested) throw new Error("Análise interrompida pelo usuário.");
      const post = await search(positions[i + 1], depth);
      const preWhite = scoreForWhite(pre.score, before.turn());
      const postWhite = scoreForWhite(post.score, after.turn());
      const loss = Math.max(0, moveColor === "w" ? preWhite - postWhite : postWhite - preWhite);
      const preForMover = moveColor === "w" ? preWhite : -preWhite;
      const postForMover = moveColor === "w" ? postWhite : -postWhite;
      const expectedLoss = Math.max(0, expectedScorePercent(preForMover) - expectedScorePercent(postForMover));
      const label = labelMove(loss);
      analysis.push({
        loss, expectedLoss, color: moveColor, label,
        scoreText: formatScore(post.score, after.turn()),
        bestMove: pre.best, nextBestMove: post.best, depth
      });
      $("analysisStatus").textContent = `Analisando ${i + 1} de ${total} · profundidade ${depth}`;
      $("progressBar").style.width = `${((i + 1) / total) * 100}%`;
      showMoves();
      render();
    }

    const whiteMoves = analysis.filter(move => move.color === "w");
    const blackMoves = analysis.filter(move => move.color === "b");
    $("accuracyWhite").textContent = accuracyFromExpectedLosses(whiteMoves);
    $("accuracyBlack").textContent = accuracyFromExpectedLosses(blackMoves);
    $("analysisStatus").textContent = `Análise concluída · profundidade ${depth}.`;
    setEngine("Stockfish · concluído", true);
    renderReport();
    showMoves();
    render();
  } catch (e) {
    console.error(e);
    $("analysisStatus").textContent = e.message;
    if (analysis.length) renderReport();
    setEngine(engineReady ? "Stockfish · pronto" : "Stockfish · indisponível", engineReady);
  } finally {
    busy = false;
    cancelRequested = false;
    $("stopBtn").disabled = true;
    $("analysisDepth").disabled = false;
    $("analyzeBtn").disabled = !sanMoves.length || !engineReady;
  }
};

$("stopBtn").onclick = () => {
  if (!busy) return;
  cancelRequested = true;
  $("stopBtn").disabled = true;
  $("analysisStatus").textContent = "Parando a análise após a busca atual…";
  if (worker && resolveSearch) worker.postMessage("stop");
};

// =========================
// INICIALIZAÇÃO
// =========================

startBundledEngine();

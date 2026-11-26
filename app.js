
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

function makeBoard(fen) {
  const temp = new Chess(fen);
  const board = temp.board();
  const el = $("board");

  el.innerHTML = "";

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const square = document.createElement("div");

      square.className =
        `square ${(r + c) % 2 === 0 ? "light" : "dark"}`;

      const piece = board[r][c];

      if (piece) {
        const span = document.createElement("span");
        span.className = "piece";
        span.textContent = glyph[piece.color + piece.type];
        square.append(span);
      }

      el.append(square);
    }
  }
}

function render() {
  if (!positions.length) return;

  makeBoard(positions[cursor]);

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
  try {
    game = new Chess();
    game.loadPgn(text);

    const history = game.history();
    const replay = new Chess();

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

    $("moveCount").textContent = history.length;
    $("loadStatus").textContent =
      `PGN carregado: ${history.length} lances.`;

    $("analyzeBtn").disabled =
      !history.length || !engineReady;

    $("accuracyWhite").textContent = "—";
    $("accuracyBlack").textContent = "—";

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

// =========================
// STOCKFISH 19
// =========================

function startEngine() {
  if (worker) return;

  setEngine("Stockfish 19 · carregando");

  try {
    // Arquivo local com o nome que você informou.
    worker = new Worker("./stockfish-19-lite.js");

    worker.onmessage = e => {
      const line = String(e.data);

      if (line === "uciok") {
        worker.postMessage("isready");
      }

      if (line === "readyok") {
        engineReady = true;

        setEngine("Stockfish 19 · pronto", true);

        $("analyzeBtn").disabled = !sanMoves.length;

        $("analysisStatus").textContent =
          "Motor pronto para análise.";
      }

      if (line.startsWith("info ") && line.includes(" score ")) {
        const scoreMatch = line.match(/score (cp|mate) (-?\d+)/);

        if (scoreMatch) {
          currentScore = {
            type: scoreMatch[1],
            value: Number(scoreMatch[2])
          };
        }

        const depthMatch = line.match(/\bdepth (\d+)/);

        if (depthMatch) {
          currentDepth = Number(depthMatch[1]);
        }
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

    worker.onerror = e => {
      console.error("Erro Stockfish:", e.message);

      engineReady = false;

      if (rejectSearch) {
        rejectSearch(new Error("Falha ao executar Stockfish."));
        rejectSearch = null;
        resolveSearch = null;
      }

      worker.terminate();
      worker = null;

      setEngine("Motor indisponível");

      $("analyzeBtn").disabled = true;

      $("analysisStatus").textContent =
        "Falha ao carregar Stockfish. Confira os arquivos JS e WASM.";
    };

    worker.postMessage("uci");

  } catch (e) {
    console.error(e);

    worker = null;
    engineReady = false;

    setEngine("Motor indisponível");

    $("analysisStatus").textContent =
      "Não foi possível iniciar o Stockfish.";
  }
}

// =========================
// BUSCA DO MOTOR
// =========================

function search(fen, depth = 12) {
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

// =========================
// CLASSIFICAÇÕES
// =========================

function labelMove(loss, move) {
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
    if (move.san.includes("+")) {
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
  $("analyzeBtn").disabled = true;

  analysis = [];

  setEngine("Stockfish 19 · analisando", true);

  const depth = 12;
  const total = sanMoves.length;

  try {
    for (let i = 0; i < total; i++) {
      const before = new Chess(positions[i]);
      const after = new Chess(positions[i + 1]);

      const moveColor = before.turn();

      const pre = await search(positions[i], depth);
      const post = await search(positions[i + 1], depth);

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

      const replay = new Chess(positions[i]);
      const playedMove = replay.move(sanMoves[i]);

      const label = labelMove(loss, playedMove);

      const scoreText =
        formatScore(post.score, after.turn());

      analysis.push({
        loss,
        label,
        scoreText,
        depth
      });

      $("analysisStatus").textContent =
        `Analisando ${i + 1} de ${total} · profundidade ${depth}`;

      $("progressBar").style.width =
        `${((i + 1) / total) * 100}%`;

      showMoves();
    }

    const whiteMoves = analysis.filter(
      (_, i) => i % 2 === 0
    );

    const blackMoves = analysis.filter(
      (_, i) => i % 2 === 1
    );

    const accuracy = arr => {
      if (!arr.length) return "—";

      const averageLoss =
        arr.reduce((sum, item) => sum + item.loss, 0) /
        arr.length;

      return Math.max(
        0,
        Math.min(100, 100 - averageLoss / 3)
      ).toFixed(1) + "%";
    };

    $("accuracyWhite").textContent =
      accuracy(whiteMoves);

    $("accuracyBlack").textContent =
      accuracy(blackMoves);

    $("analysisStatus").textContent =
      "Análise concluída. Toque em um lance para ver sua classificação.";

    setEngine("Stockfish 19 · concluído", true);

    showMoves();
    render();

  } catch (e) {
    console.error(e);

    $("analysisStatus").textContent =
      "Erro durante a análise: " + e.message;
  }

  busy = false;
  $("analyzeBtn").disabled =
    !sanMoves.length || !engineReady;
};

// =========================
// INICIALIZAÇÃO
// =========================

startEngine();

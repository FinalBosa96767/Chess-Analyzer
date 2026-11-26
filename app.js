import { Chess } from "https://cdn.jsdelivr.net/npm/chess.js@1.4.0/+esm";

const $ = id => document.getElementById(id);
const glyph = {wk:"♔",wq:"♕",wr:"♖",wb:"♗",wn:"♘",wp:"♙",bk:"♚",bq:"♛",br:"♜",bb:"♝",bn:"♞",bp:"♟"};
let game = new Chess(), positions = [], sanMoves = [], analysis = [], cursor = 0, worker = null, engineReady = false, busy = false;

function setEngine(text, ok=false) {
  $("engineState").innerHTML = `<i style="background:${ok?"#78c99b":"#e0b75d"}"></i> ${text}`;
}
function makeBoard(fen) {
  const temp = new Chess(fen), board = temp.board(), el = $("board");
  el.innerHTML = "";
  for (let r=0;r<8;r++) for(let c=0;c<8;c++) {
    const square = document.createElement("div");
    square.className = `square ${(r+c)%2===0?"light":"dark"}`;
    const p = board[r][c];
    if(p) {
      const span=document.createElement("span"); span.className="piece";
      span.textContent=glyph[p.color+p.type]; square.append(span);
    }
    el.append(square);
  }
}
function render() {
  if(!positions.length) return;
  makeBoard(positions[cursor]);
  $("moveCounter").textContent = `${cursor} / ${sanMoves.length}`;
  $("turnLabel").textContent = cursor===0 ? "Posição inicial" : `Após ${cursor} ${cursor===1?"lance":"lances"}`;
  $("prevBtn").disabled=cursor===0; $("nextBtn").disabled=cursor===sanMoves.length;
  const row=analysis[cursor-1];
  $("evalLabel").textContent=row?.scoreText ? `Avaliação: ${row.scoreText}` : "Avaliação: —";
  document.querySelectorAll(".move-cell").forEach(x=>x.classList.remove("active"));
  const active=document.querySelector(`[data-ply="${cursor-1}"]`); if(active) active.classList.add("active");
}
function showMoves() {
  const list=$("moveList"); list.innerHTML="";
  if(!sanMoves.length){list.innerHTML='<div class="empty">Sua partida aparecerá aqui.</div>';return;}
  for(let i=0;i<sanMoves.length;i+=2){
    const row=document.createElement("div"); row.className="move-row";
    const n=document.createElement("span"); n.className="move-no"; n.textContent=`${Math.floor(i/2)+1}.`; row.append(n);
    for(let j=i;j<Math.min(i+2,sanMoves.length);j++){
      const cell=document.createElement("span"); cell.className="move-cell"; cell.dataset.ply=j; cell.textContent=sanMoves[j];
      cell.onclick=()=>{cursor=j+1;render()}; const tag=analysis[j]?.label;
      if(tag){const b=document.createElement("b");b.className=`tag ${tag.css}`;b.textContent=tag.symbol;cell.append(b)}
      row.append(cell);
    }
    list.append(row);
  }
}
function loadPgn(text) {
  try {
    game=new Chess(); game.loadPgn(text);
    const history=game.history();
    const replay=new Chess(); positions=[replay.fen()]; sanMoves=[];
    for(const san of history){const move=replay.move(san); if(!move) throw new Error("Lance inválido: "+san); sanMoves.push(move.san); positions.push(replay.fen());}
    analysis=[]; cursor=0; $("moveCount").textContent=history.length;
    $("loadStatus").textContent=`PGN carregado: ${history.length} lances.`;
    $("analyzeBtn").disabled=!history.length; $("accuracyWhite").textContent="—";$("accuracyBlack").textContent="—";
    showMoves();render();$("analysisStatus").textContent="Pronto para analisar.";
  } catch(e) { $("loadStatus").textContent="Não consegui ler o PGN: "+e.message; }
}
$("loadBtn").onclick=()=>loadPgn($("pgnInput").value);
$("pgnFile").onchange=async e=>{const f=e.target.files[0];if(f){const t=await f.text();$("pgnInput").value=t;loadPgn(t)}};
$("prevBtn").onclick=()=>{cursor=Math.max(0,cursor-1);render()};
$("nextBtn").onclick=()=>{cursor=Math.min(sanMoves.length,cursor+1);render()};

function startEngine() {
  if(worker) return;
  try {
    // Stockfish.js 19 lite single-threaded: ~1.7 MB, no cross-origin isolation required.
    worker=new Worker("https://cdn.jsdelivr.net/npm/stockfish@19.0.1/bin/stockfish-19-lite-single.js");
    worker.onmessage=e=>{
      const line=String(e.data);
      if(line==="uciok"){worker.postMessage("isready")}
      if(line==="readyok"){engineReady=true;setEngine("Stockfish 19 · pronto",true);$("analyzeBtn").disabled=!sanMoves.length}
      if(line.startsWith("info ") && line.includes(" score ")) {
        const m=line.match(/score (cp|mate) (-?\d+)/);
        if(m) currentScore={type:m[1],value:Number(m[2])};
        const d=line.match(/\bdepth (\d+)/); if(d) currentDepth=Number(d[1]);
      }
      if(line.startsWith("bestmove")) {
        const result={score:currentScore,depth:currentDepth,best:line.split(/\s+/)[1]};
        if(resolveSearch){const r=resolveSearch;resolveSearch=null;r(result)}
      }
    };
    worker.onerror=()=>{setEngine("Falha ao carregar motor");$("analysisStatus").textContent="O navegador não conseguiu carregar o motor. Tente atualizar a página ou usar Chrome."};
    worker.postMessage("uci");
  } catch(e){setEngine("Motor indisponível")}
}
let currentScore=null,currentDepth=0,resolveSearch=null;
function search(fen,depth=12) {
  return new Promise(resolve=>{
    currentScore=null;currentDepth=0;resolveSearch=resolve;
    worker.postMessage("position fen "+fen);
    worker.postMessage("go depth "+depth);
  });
}
function labelMove(loss, fenAfter, bestMove, playedUci, isBook=false) {
  if(isBook)return {name:"Livro",symbol:"▤",css:"c-book"};
  if(loss<=5)return {name:"Melhor",symbol:"★",css:"c-best"};
  if(loss<=18)return {name:"Excelente",symbol:"!",css:"c-excellent"};
  if(loss<=45)return {name:"Bom",symbol:"✓",css:"c-good"};
  if(loss<=90)return {name:"Imprecisão",symbol:"?!",css:"c-inaccuracy"};
  if(loss<=180)return {name:"Erro",symbol:"?",css:"c-mistake"};
  return {name:"Erro grave",symbol:"??",css:"c-blunder"};
}
function scoreForWhite(s) {
  if(!s)return 0;
  if(s.type==="mate") return Math.sign(s.value)*(100000-Math.abs(s.value)*100);
  return s.value;
}
$("analyzeBtn").onclick=async()=>{
  if(!engineReady||busy||!positions.length)return;
  busy=true;$("analyzeBtn").disabled=true;analysis=[];setEngine("Stockfish 19 · analisando",true);
  const depth=12, total=sanMoves.length;
  try {
    for(let i=0;i<total;i++){
      const before=new Chess(positions[i]), after=new Chess(positions[i+1]);
      const moveColor=before.turn();
      const pre=await search(positions[i],depth);
      const post=await search(positions[i+1],depth);
      const bestWhite=scoreForWhite(pre.score), playedWhite=scoreForWhite(post.score);
      const loss=Math.max(0, moveColor==="w" ? bestWhite-playedWhite : playedWhite-bestWhite);
      let label=labelMove(loss,positions[i+1],pre.best,null,false);
      // Experimental !? heuristic: near-best move that gives check or creates a direct forcing threat.
      const played=before.history({verbose:true}).slice(-1)[0];
      const lastMove=before.move(sanMoves[i]);
      if(loss<=35 && lastMove && (lastMove.san.includes("+") || lastMove.san.includes("#")) && label.name!=="Melhor"){
        label={name:"Traiçoeiro",symbol:"!?",css:"c-tricky"};
      }
      const scoreText=post.score ? (post.score.type==="mate"?`#${post.score.value}`:`${(playedWhite/100).toFixed(2)}`) : "—";
      analysis.push({loss,label,scoreText,depth});
      $("analysisStatus").textContent=`Analisando ${i+1} de ${total} · profundidade ${depth}`;
      $("progressBar").style.width=`${((i+1)/total)*100}%`;
      showMoves();
    }
    const w=analysis.filter((x,i)=>beforeColor(i)==="w"), b=analysis.filter((x,i)=>beforeColor(i)==="b");
    const accuracy=arr=>arr.length?Math.max(0,Math.min(100,100-arr.reduce((s,x)=>s+x.loss,0)/(arr.length*3))).toFixed(1)+"%":"—";
    $("accuracyWhite").textContent=accuracy(w);$("accuracyBlack").textContent=accuracy(b);
    $("analysisStatus").textContent="Análise concluída. Toque em um lance para ver sua classificação.";
    setEngine("Stockfish 19 · concluído",true);showMoves();render();
  } catch(e){$("analysisStatus").textContent="Erro durante análise: "+e.message}
  busy=false;$("analyzeBtn").disabled=false;
};
function beforeColor(i){return i%2===0?"w":"b"}
startEngine();

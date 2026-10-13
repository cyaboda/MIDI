// Audio to MIDI V1. Model and library are loaded from public CDNs on first use.
const $=id=>document.getElementById(id);
let file=null, midiBlob=null, objectURL=null, busy=false;
let originalNotes=[],detectedNotes=[],midiAudioContext=null,midiVoices=[],midiStopTimer=null,midiPlaying=false;
let midiPaused=false, playbackStartAt=0, playbackDuration=0, playheadFrame=null;
let selectedNoteKey=null; const velocityEdits=new Map(); let rollWidth=660,rollDuration=1;
const MODEL_URL=new URL('./model/model.json', import.meta.url).href;
const setStatus=(s)=>{$('status').textContent=s};
const progress=p=>{$('progress').style.display='block';$('bar').style.width=Math.max(0,Math.min(100,p))+'%'};
function selectFile(f){if(!f)return;stopMidiPlayback();originalNotes=[];detectedNotes=[];velocityEdits.clear();selectedNoteKey=null;$('empty').style.display='flex';if(!/\.(wav|mp3|ogg|flac|m4a|aiff?)$/i.test(f.name)&&!f.type.startsWith('audio/')){setStatus('Selecciona un archivo de audio válido.');return;}file=f;midiBlob=null;$('download').disabled=true;$('convert').disabled=false;$('result').style.display='none';$('progress').style.display='none';$('filename').textContent=f.name;$('filesize').textContent=(f.size/1024/1024).toFixed(2)+' MB';$('fileInfo').classList.add('active');if(objectURL)URL.revokeObjectURL(objectURL);objectURL=URL.createObjectURL(f);$('player').src=objectURL;$('player').style.display='block';setStatus('Archivo listo para convertir.');}
$('drop').onclick=()=>$('file').click();$('drop').onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();$('file').click()}};$('file').onchange=e=>selectFile(e.target.files[0]);$('drop').ondragover=e=>{e.preventDefault();$('drop').classList.add('drag')};$('drop').ondragleave=()=>$('drop').classList.remove('drag');$('drop').ondrop=e=>{e.preventDefault();$('drop').classList.remove('drag');selectFile(e.dataTransfer.files[0])};
function varlen(n){n=Math.max(0,Math.round(n));let b=[n&127];while((n>>=7))b.unshift((n&127)|128);return b;}
function chunk(name,bytes){let n=bytes.length;return [...name].map(x=>x.charCodeAt(0)).concat([(n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255],bytes)}
function midiFromNotes(notes){const ppq=480,tempo=500000;let events=[];for(const note of notes){const pitch=Math.max(0,Math.min(127,Math.round(note.pitchMidi??note.pitch??60)));const start=Math.max(0,Math.round(note.startTime*960));const end=Math.max(start+1,Math.round(note.endTime*960));const velocity=note.velocity??defaultVelocity(note);events.push({tick:start,bytes:[0x90,pitch,velocity],order:1},{tick:end,bytes:[0x80,pitch,0],order:0})}events.sort((a,b)=>a.tick-b.tick||a.order-b.order);let data=[0,0xff,0x51,3,(tempo>>16)&255,(tempo>>8)&255,tempo&255];let last=0;for(const e of events){data.push(...varlen(e.tick-last),...e.bytes);last=e.tick}data.push(0,0xff,0x2f,0);const header=chunk('MThd',[0,0,0,1,ppq>>8,ppq&255]);return new Blob([new Uint8Array([...header,...chunk('MTrk',data)])],{type:'audio/midi'})}
async function prepareModelAudio(decoded){
  // Basic Pitch expects a mono AudioBuffer sampled at exactly 22050 Hz.
  const targetRate=22050;
  const length=Math.max(1,Math.ceil(decoded.duration*targetRate));
  const offline=new OfflineAudioContext(1,length,targetRate);
  const source=offline.createBufferSource();
  source.buffer=decoded;
  source.connect(offline.destination);
  source.start(0);
  const rendered=await offline.startRendering();
  if(rendered.sampleRate!==targetRate)throw Error('No se pudo convertir el audio a 22050 Hz.');
  return rendered;
}
function defaultVelocity(n){return Math.max(1,Math.min(127,Math.round((n.amplitude??0.8)*110)));}
function noteKey(n){return `${n.pitchMidi}|${Math.round(n.startTime*1000)}`;}
function noteVelocity(n){return velocityEdits.get(noteKey(n))??defaultVelocity(n);}
function noteLabel(p){const names=['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];return names[p%12]+(Math.floor(p/12)-1);}
function velocityColor(v){const hue=Math.round(220-(Math.max(1,Math.min(127,v))-1)/126*215);return `hsl(${hue} 82% 65%)`;}
function preview(notes){
  const roll=$('roll');roll.replaceChildren();
  const minPitch=Math.max(0,Math.min(...notes.map(n=>n.pitchMidi))-2),maxPitch=Math.min(127,Math.max(...notes.map(n=>n.pitchMidi))+2);
  rollDuration=Math.max(.5,...notes.map(n=>n.endTime));rollWidth=Math.max(700,Math.round(rollDuration*100));
  const width=rollWidth+44,height=(maxPitch-minPitch+1)*16+27,NS='http://www.w3.org/2000/svg',svg=document.createElementNS(NS,'svg');
  svg.setAttribute('width',width);svg.setAttribute('height',height);svg.setAttribute('viewBox',`0 0 ${width} ${height}`);
  const node=(tag,attrs,parent=svg)=>{const e=document.createElementNS(NS,tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,v);parent.append(e);return e;};
  node('rect',{x:0,y:0,width,height:27,fill:'#1d232d'});
  for(let t=0;t<=rollDuration;t+=1){const x=44+t*100;node('line',{x1:x,x2:x,y1:27,y2:height,stroke:t%5===0?'#414953':'#2a313b','stroke-width':t%5===0?1.2:.6});if(t%2===0){const text=node('text',{x:x+5,y:18,fill:'#8d96a5','font-size':11});text.textContent=`${t}s`;}}
  for(let p=minPitch;p<=maxPitch;p++){
    const y=27+(maxPitch-p)*16,black=[1,3,6,8,10].includes(p%12);
    node('rect',{x:44,y,width:rollWidth,height:16,fill:p%12===0?'#29303b':black?'#181e27':'#202630'});
    node('line',{x1:44,x2:width,y1:y+16,y2:y+16,stroke:'#2b323b','stroke-width':.5});
    node('rect',{x:0,y,width:44,height:16,fill:black?'#15191f':'#e0e3e8',stroke:'#777e89','stroke-width':.35});
    if(p%12===0){const text=node('text',{x:6,y:y+11,fill:'#20252c','font-size':10,'font-weight':700});text.textContent=noteLabel(p);}
  }
  for(const n of notes){const rect=node('rect',{x:44+n.startTime*100,y:27+(maxPitch-n.pitchMidi)*16+2,width:Math.max(2,(n.endTime-n.startTime)*100),height:12,rx:3,fill:selectedNoteKey===noteKey(n)?'#873F52':velocityColor(noteVelocity(n))});rect.style.cursor='pointer';rect.dataset.key=noteKey(n);rect.addEventListener('click',()=>selectVelocityNote(noteKey(n)));const t=node('title',{},rect);t.textContent=`${noteLabel(n.pitchMidi)} · velocidad ${noteVelocity(n)} · ${n.startTime.toFixed(2)}–${n.endTime.toFixed(2)} s`;}
  const head=node('g',{id:'svgPlayhead','pointer-events':'none'});
  node('line',{x1:0,x2:0,y1:27,y2:height,stroke:'#c0778d','stroke-width':6,opacity:.25},head);
  node('line',{x1:0,x2:0,y1:27,y2:height,stroke:'#ed91b0','stroke-width':2},head);
  node('path',{d:'M -7 27 L 7 27 L 0 38 Z',fill:'#ed91b0'},head);
  roll.append(svg);updatePlayhead(0);$('stats').textContent=`${notes.length} notas · ${rollDuration.toFixed(2)} s · Desplázate horizontalmente para explorar.`;$('result').style.display='flex';$('empty').style.display='none';renderVelocityBars();
}
function selectVelocityNote(key){
  selectedNoteKey=key;const note=detectedNotes.find(n=>noteKey(n)===key);if(!note)return;
  const velocity=noteVelocity(note);$('velocitySlider').disabled=false;$('resetVelocity').disabled=false;$('velocitySlider').value=velocity;$('velocityValue').textContent=velocity;$('selectedNote').textContent=`${noteLabel(note.pitchMidi)} · ${note.startTime.toFixed(2)} s`;
  document.querySelectorAll('#roll [data-key]').forEach(el=>el.setAttribute('fill',el.dataset.key===key?'#873F52':velocityColor(noteVelocity(detectedNotes.find(n=>noteKey(n)===el.dataset.key) || note))));
  document.querySelectorAll('.velocity-bar').forEach(el=>el.classList.toggle('selected',el.dataset.key===key));
}
function setNoteVelocity(key,value){
  const note=detectedNotes.find(n=>noteKey(n)===key);if(!note)return;
  const v=Math.max(1,Math.min(127,Math.round(value)));velocityEdits.set(key,v);selectedNoteKey=key;
  note.velocity=v; midiBlob=midiFromNotes(detectedNotes);$('download').disabled=false;
  const bar=Array.from(document.querySelectorAll('.velocity-bar')).find(el=>el.dataset.key===key);
  if(bar){bar.style.height=(v/127*100)+'%';bar.style.background=velocityColor(v);bar.title=`${noteLabel(note.pitchMidi)} · ${v}`;}
  selectVelocityNote(key);$('velocitySummary').textContent='Cambio aplicado a la reproducción y al archivo MIDI. No hace falta volver a convertir.';
}
function renderVelocityBars(){
  const holder=$('velocityBars');holder.replaceChildren();holder.style.width=(rollWidth+44)+'px';
  for(const note of detectedNotes){const key=noteKey(note),bar=document.createElement('div');bar.className='velocity-bar';bar.dataset.key=key;bar.style.left=(44+note.startTime*100)+'px';bar.style.height=(noteVelocity(note)/127*100)+'%';bar.style.background=velocityColor(noteVelocity(note));bar.title=`${noteLabel(note.pitchMidi)} · ${noteVelocity(note)}`;bar.classList.toggle('selected',key===selectedNoteKey);
    bar.addEventListener('pointerdown',e=>{e.preventDefault();bar.setPointerCapture(e.pointerId);const update=ev=>{const rect=holder.getBoundingClientRect(),h=holder.clientHeight,y=ev.clientY-rect.top;setNoteVelocity(key,Math.round((1-y/h)*127));};update(e);const move=ev=>update(ev);const done=()=>{bar.removeEventListener('pointermove',move);bar.removeEventListener('pointerup',done);bar.removeEventListener('pointercancel',done)};bar.addEventListener('pointermove',move);bar.addEventListener('pointerup',done);bar.addEventListener('pointercancel',done)});holder.append(bar);
  }
  holder.append($('velocityPlayhead'));updatePlayhead(0);
  const current=detectedNotes.find(n=>noteKey(n)===selectedNoteKey);
  if(current)selectVelocityNote(selectedNoteKey);else{$('velocitySlider').disabled=true;$('resetVelocity').disabled=true;$('velocityValue').textContent='—';$('selectedNote').textContent='Selecciona una nota';}
}
$('velocitySlider').addEventListener('input',e=>{if(selectedNoteKey)setNoteVelocity(selectedNoteKey,Number(e.target.value))});
$('resetVelocity').addEventListener('click',()=>{if(!selectedNoteKey)return;const note=detectedNotes.find(n=>noteKey(n)===selectedNoteKey);if(!note)return;velocityEdits.delete(selectedNoteKey);setNoteVelocity(selectedNoteKey,defaultVelocity(note));velocityEdits.delete(selectedNoteKey)});
// Horizontal scrolling stays aligned between the note grid and velocity lane.
let syncingScroll=false;
for(const [a,b] of [[$('roll'),$('velocityScroll')],[$('velocityScroll'),$('roll')]])a.addEventListener('scroll',()=>{if(syncingScroll)return;syncingScroll=true;b.scrollLeft=a.scrollLeft;requestAnimationFrame(()=>{syncingScroll=false})});
$('convert').onclick=async()=>{if(!file||busy)return;stopMidiPlayback();originalNotes=[];detectedNotes=[];busy=true;$('convert').disabled=true;$('download').disabled=true;try{progress(3);setStatus('Cargando motor de transcripción…');const lib=await import('https://esm.sh/@spotify/basic-pitch@1.0.1?bundle');const {BasicPitch,outputToNotesPoly,addPitchBendsToNoteEvents,noteFramesToTime}=lib;if(!BasicPitch||!outputToNotesPoly)throw Error('La librería no devolvió las funciones necesarias.');progress(12);setStatus('Decodificando audio…');const ctx=new (window.AudioContext||window.webkitAudioContext)();let audio;try{audio=await ctx.decodeAudioData(await file.arrayBuffer())}finally{await ctx.close()}if(audio.duration>180)throw Error('En esta versión utiliza fragmentos de hasta 3 minutos.');progress(16);setStatus('Adaptando audio a 22.050 Hz y mono…');audio=await prepareModelAudio(audio);progress(20);setStatus('Cargando modelo de IA (la primera vez puede tardar)…');const model=new BasicPitch(MODEL_URL);const frames=[],onsets=[],contours=[];setStatus('Detectando notas y acordes…');await model.evaluateModel(audio,(f,o,c)=>{frames.push(...f);onsets.push(...o);contours.push(...c)},p=>{progress(20+Math.round(p*0.7));setStatus(`Analizando audio… ${Math.round(p)}%`)});progress(94);setStatus('Preparando MIDI…');const mode=$('sensitivity').value;const threshold=mode==='sensitive'?.18:mode==='strict'?.38:.25;const raw=outputToNotesPoly(frames,onsets,threshold,threshold,5);const withBends=addPitchBendsToNoteEvents(contours,raw);const notes=noteFramesToTime(withBends).map(n=>({pitchMidi:Math.round(n.pitchMidi),amplitude:n.amplitude,startTime:Math.max(0,n.startTimeSeconds),endTime:Math.max(0,n.startTimeSeconds+n.durationSeconds)})).filter(n=>Number.isFinite(n.pitchMidi)&&Number.isFinite(n.startTime)&&Number.isFinite(n.endTime)&&n.endTime>n.startTime);console.info('Basic Pitch:',{frames:frames.length,rawNotes:raw.length,validNotes:notes.length});if(!notes.length)throw Error(raw.length?'El modelo detectó notas pero ninguna tenía tiempos válidos. Revisa la consola.':'El modelo no detectó notas con estos ajustes. Prueba «Más notas».');originalNotes=notes;velocityEdits.clear();selectedNoteKey=null;applyMidiCleaning();$('playMidi').disabled=false;$('download').disabled=false;seekOffset=0;progress(100);setStatus('¡Listo! MIDI generado en tu navegador.')}catch(err){console.error(err);setStatus('No se pudo convertir: '+(err?.message||String(err))+' Revisa la pestaña Network para ver qué recurso falló.');$('progress').style.display='none'}finally{busy=false;$('convert').disabled=!file}};
// Beta 1.6: limpieza local sin volver a ejecutar el modelo.
// Se conserva siempre la transcripción original para que el control sea reversible.
function cleanMidiNotes(notes, level){
  if(level<=0)return notes.slice();
  const strength=level/100;
  const amplitudes=notes.map(n=>Number.isFinite(n.amplitude)?n.amplitude:0.6).sort((a,b)=>a-b);
  const median=amplitudes[Math.floor(amplitudes.length/2)]??0.6;
  // Umbrales suaves relativos al audio, no una escala absoluta universal.
  const minDuration=0.025+strength*strength*0.115;
  const minAmplitude=median*(0.12+strength*strength*0.72);
  const filtered=notes.filter(n=>n.endTime-n.startTime>=minDuration && (n.amplitude??median)>=minAmplitude)
    .sort((a,b)=>a.pitchMidi-b.pitchMidi||a.startTime-b.startTime);
  // Fusiona fragmentos adyacentes de la misma nota solo si la separación es muy corta.
  const merged=[];
  const maxGap=0.012+strength*0.035;
  for(const note of filtered){
    const prev=merged[merged.length-1];
    if(prev && prev.pitchMidi===note.pitchMidi && note.startTime<=prev.endTime+maxGap){
      prev.endTime=Math.max(prev.endTime,note.endTime);
      prev.amplitude=Math.max(prev.amplitude??0,note.amplitude??0);
    }else merged.push({...note});
  }
  return merged.sort((a,b)=>a.startTime-b.startTime||a.pitchMidi-b.pitchMidi);
}
function applyMidiCleaning(){
  if(!originalNotes.length)return;
  stopMidiPlayback();
  const level=Number($('cleaning').value);
  detectedNotes=cleanMidiNotes(originalNotes,level).map(n=>({...n,velocity:velocityEdits.get(noteKey(n))??defaultVelocity(n)}));
  $('cleaningValue').textContent=level+'%';
  $('cleaningSummary').textContent=`${originalNotes.length} notas originales · ${detectedNotes.length} después de limpiar · ${originalNotes.length-detectedNotes.length} eliminadas o fusionadas`;
  if(detectedNotes.length){
    midiBlob=midiFromNotes(detectedNotes);
    preview(detectedNotes);
    $('download').disabled=false;
    $('playMidi').disabled=false;
  }else{
    midiBlob=null;
    $('roll').replaceChildren();
    $('stats').textContent='El filtro eliminó todas las notas. Reduce la limpieza.';
    $('download').disabled=true;
    $('playMidi').disabled=true;
  }
}
$('cleaning').addEventListener('input',applyMidiCleaning);
$('download').onclick=()=>{if(!midiBlob)return;const url=URL.createObjectURL(midiBlob);const a=document.createElement('a');a.href=url;a.download=(file?.name||'audio').replace(/\.[^.]+$/,'')+'.mid';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000)};

// AUREL 2.2: locally synthesized piano timbre. No external downloads.
const pianoBuffers=new Map();
function pianoBuffer(ctx,pitch){
  if(pianoBuffers.has(pitch))return pianoBuffers.get(pitch);
  const sr=ctx.sampleRate, seconds=3.6, size=Math.ceil(sr*seconds),buf=ctx.createBuffer(1,size,sr),data=buf.getChannelData(0);
  const f=440*Math.pow(2,(pitch-69)/12);
  const harmonics=[1,.42,.21,.13,.075,.04,.022];
  const phases=harmonics.map((_,i)=>i*0.73);
  for(let i=0;i<size;i++){
    const t=i/sr, attack=1-Math.exp(-t*800);
    let v=0;
    for(let h=0;h<harmonics.length;h++){
      const k=h+1, frequency=f*k*Math.sqrt(1+0.00013*k*k);
      if(frequency>=sr*.48)continue;
      const decay=Math.exp(-t*(1.2+h*.62));
      v+=harmonics[h]*decay*Math.sin(2*Math.PI*frequency*t+phases[h]);
    }
    // The soft percussive hammer transient avoids a sustained flute-like tone.
    const hammer=.09*Math.exp(-t*65)*Math.sin(2*Math.PI*Math.min(f*5,sr*.42)*t);
    data[i]=(v+hammer)*attack*.54;
  }
  pianoBuffers.set(pitch,buf);return buf;
}
// Beta 1.5: local MIDI note audition using Web Audio. No external soundfont needed.
// AUREL 2.3: shared AudioContext clock, resumable pause and synchronized playhead.
function formatClock(t){t=Math.max(0,Math.floor(t||0));return `${Math.floor(t/60)}:${String(t%60).padStart(2,'0')}`;}
function playbackPosition(){return midiAudioContext?Math.max(0,Math.min(playbackDuration,midiAudioContext.currentTime-playbackStartAt)):0;}
function updatePlayhead(time){
  const x=Math.max(0,time*100);
  const svgHead=$('svgPlayhead');
  if(svgHead){svgHead.setAttribute('transform',`translate(${Math.min(x,rollWidth)+44},0)`);svgHead.style.display=detectedNotes.length?'':'none';}
  const velocityHead=$('velocityPlayhead');
  if(velocityHead){velocityHead.style.left=(x+44)+'px';velocityHead.style.display=detectedNotes.length?'block':'none';}
  const total=playbackDuration||Math.max(0,...detectedNotes.map(n=>n.endTime));
  $('transportTime').textContent=`${formatClock(time)} / ${formatClock(total)}`;
}
function tickPlayhead(){
  if(!midiPlaying||midiPaused||!midiAudioContext)return;
  const time=playbackPosition();updatePlayhead(time);
  const roll=$('roll'),px=time*100;
  if(px>roll.scrollLeft+roll.clientWidth-55 || px<roll.scrollLeft){roll.scrollLeft=Math.max(0,px-roll.clientWidth*.25);}
  if(time>=playbackDuration+.16){stopMidiPlayback();$('midiPlaybackStatus').textContent='Reproducción finalizada.';return;}
  playheadFrame=requestAnimationFrame(tickPlayhead);
}
function stopMidiPlayback(){
  if(playheadFrame!==null){cancelAnimationFrame(playheadFrame);playheadFrame=null;}
  if(midiStopTimer!==null){clearTimeout(midiStopTimer);midiStopTimer=null;}
  for(const voice of midiVoices){try{voice.source.stop()}catch(e){}try{voice.source.disconnect();voice.gain.disconnect()}catch(e){}}
  midiVoices=[];midiPlaying=false;midiPaused=false;playbackStartAt=0;playbackDuration=0;seekOffset=0;
  if(midiAudioContext){const ctx=midiAudioContext;midiAudioContext=null;ctx.close().catch(()=>{});}
  if($('playMidi')){$('playMidi').disabled=!detectedNotes.length;$('playMidi').textContent='▶';$('playMidi').setAttribute('aria-label','Reproducir MIDI');}
  if($('stopMidi'))$('stopMidi').disabled=true;
  updatePlayhead(0);
  if($('midiPlaybackStatus'))$('midiPlaybackStatus').textContent='Reproducción detenida.';
}
async function playMidiPlayback(){
  if(!detectedNotes.length)return;
  if(midiPlaying){
    const ctx=midiAudioContext;if(!ctx)return;
    if(!midiPaused){
      // Suspend freezes the audio clock and all scheduled voices at their current position.
      midiPaused=true;
      if(playheadFrame!==null){cancelAnimationFrame(playheadFrame);playheadFrame=null;}
      await ctx.suspend();
      if(midiAudioContext!==ctx)return;
      updatePlayhead(playbackPosition());
      $('playMidi').textContent='▶';$('playMidi').setAttribute('aria-label','Continuar MIDI');
      $('midiPlaybackStatus').textContent='Reproducción en pausa.';
    }else{
      await ctx.resume();if(midiAudioContext!==ctx)return;
      midiPaused=false;$('playMidi').textContent='Ⅱ';$('playMidi').setAttribute('aria-label','Pausar MIDI');
      $('midiPlaybackStatus').textContent='Reproduciendo MIDI con piano…';tickPlayhead();
    }
    return;
  }
  const ctx=new (window.AudioContext||window.webkitAudioContext)();midiAudioContext=ctx;
  try{
    await ctx.resume();if(midiAudioContext!==ctx){await ctx.close();return;}
    const startAt=ctx.currentTime+0.08;
    playbackStartAt=startAt-seekOffset;playbackDuration=Math.max(...detectedNotes.map(n=>n.endTime));
    for(const note of detectedNotes){
      const start=Math.max(0,note.startTime),end=Math.max(start+0.02,note.endTime);
      const pitch=Math.max(0,Math.min(127,Math.round(note.pitchMidi)));
      const source=ctx.createBufferSource(),gain=ctx.createGain();source.buffer=pianoBuffer(ctx,pitch);
      const volume=Math.max(0.012,Math.min(0.30,Math.pow(noteVelocity(note)/127,1.5)*0.24*(Number(document.getElementById("midiVolume")?.value??75)/75)));
      if(end<=seekOffset)continue;
      const at=startAt+Math.max(0,start-seekOffset),off=startAt+end-seekOffset;
      gain.gain.setValueAtTime(0,at);
      gain.gain.linearRampToValueAtTime(volume,at+0.006);
      gain.gain.setValueAtTime(volume,Math.max(at+0.006,off-0.08));
      gain.gain.exponentialRampToValueAtTime(0.0001,Math.max(at+0.012,off+0.14));
      source.connect(gain);gain.connect(ctx.destination);
      source.start(at);source.stop(Math.min(at+3.6,off+0.16));midiVoices.push({source,gain});
    }
    midiPlaying=true;midiPaused=false;
    $('playMidi').textContent='Ⅱ';$('playMidi').setAttribute('aria-label','Pausar MIDI');$('stopMidi').disabled=false;
    $('midiPlaybackStatus').textContent=`Reproduciendo ${detectedNotes.length} notas con piano…`;
    tickPlayhead();
  }catch(err){stopMidiPlayback();console.error(err);$('midiPlaybackStatus').textContent='No se pudo reproducir: '+(err.message||err);}
}
$('playMidi').onclick=playMidiPlayback;
$('stopMidi').onclick=stopMidiPlayback;

// AUREL 3.0 workspace controls. Scrubbing resumes from chosen time on the next Play.
const midiSeek=document.getElementById('midiSeek');
const midiVolume=document.getElementById('midiVolume');
let zoomFactor=1;
let seekOffset=0;
for(const [id,factor] of [['zoomOut',.8],['zoomIn',1.25]])document.getElementById(id).addEventListener('click',()=>{zoomFactor=Math.max(.5,Math.min(2.5,zoomFactor*factor));document.getElementById('roll').style.zoom=zoomFactor;document.getElementById('velocityScroll').style.zoom=zoomFactor;});
document.getElementById('zoomFit').addEventListener('click',()=>{zoomFactor=1;document.getElementById('roll').style.zoom=1;document.getElementById('velocityScroll').style.zoom=1;});
midiSeek.addEventListener('input',()=>{if(!detectedNotes.length)return;const desired=(Number(midiSeek.value)/1000)*playbackDuration; if(midiPlaying&&!midiPaused){document.getElementById('playMidi').click();}stopMidiPlayback();seekOffset=desired;playbackDuration=Math.max(...detectedNotes.map(n=>n.endTime));updatePlayhead(desired);});
const _updatePlayheadV3=updatePlayhead;updatePlayhead=function(t){_updatePlayheadV3(t);if(midiSeek&&document.activeElement!==midiSeek){midiSeek.disabled=!detectedNotes.length;midiSeek.value=playbackDuration?Math.round(1000*t/playbackDuration):0;}};

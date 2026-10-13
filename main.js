// Audio to MIDI V1. Model and library are loaded from public CDNs on first use.
const $=id=>document.getElementById(id);
let file=null, midiBlob=null, objectURL=null, busy=false;
let detectedNotes=[],midiAudioContext=null,midiVoices=[],midiStopTimer=null,midiPlaying=false;
const MODEL_URL=new URL('./model/model.json', import.meta.url).href;
const setStatus=(s)=>{$('status').textContent=s};
const progress=p=>{$('progress').style.display='block';$('bar').style.width=Math.max(0,Math.min(100,p))+'%'};
function selectFile(f){if(!f)return;stopMidiPlayback();detectedNotes=[];if(!/\.(wav|mp3|ogg|flac|m4a|aiff?)$/i.test(f.name)&&!f.type.startsWith('audio/')){setStatus('Selecciona un archivo de audio válido.');return;}file=f;midiBlob=null;$('download').disabled=true;$('convert').disabled=false;$('result').style.display='none';$('progress').style.display='none';$('filename').textContent=f.name;$('filesize').textContent=(f.size/1024/1024).toFixed(2)+' MB';$('fileInfo').classList.add('active');if(objectURL)URL.revokeObjectURL(objectURL);objectURL=URL.createObjectURL(f);$('player').src=objectURL;$('player').style.display='block';setStatus('Archivo listo para convertir.');}
$('drop').onclick=()=>$('file').click();$('drop').onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();$('file').click()}};$('file').onchange=e=>selectFile(e.target.files[0]);$('drop').ondragover=e=>{e.preventDefault();$('drop').classList.add('drag')};$('drop').ondragleave=()=>$('drop').classList.remove('drag');$('drop').ondrop=e=>{e.preventDefault();$('drop').classList.remove('drag');selectFile(e.dataTransfer.files[0])};
function varlen(n){n=Math.max(0,Math.round(n));let b=[n&127];while((n>>=7))b.unshift((n&127)|128);return b;}
function chunk(name,bytes){let n=bytes.length;return [...name].map(x=>x.charCodeAt(0)).concat([(n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255],bytes)}
function midiFromNotes(notes){const ppq=480,tempo=500000;let events=[];for(const note of notes){const pitch=Math.max(0,Math.min(127,Math.round(note.pitchMidi??note.pitch??60)));const start=Math.max(0,Math.round(note.startTime*960));const end=Math.max(start+1,Math.round(note.endTime*960));const velocity=Math.max(1,Math.min(127,Math.round((note.amplitude??0.8)*110)));events.push({tick:start,bytes:[0x90,pitch,velocity],order:1},{tick:end,bytes:[0x80,pitch,0],order:0})}events.sort((a,b)=>a.tick-b.tick||a.order-b.order);let data=[0,0xff,0x51,3,(tempo>>16)&255,(tempo>>8)&255,tempo&255];let last=0;for(const e of events){data.push(...varlen(e.tick-last),...e.bytes);last=e.tick}data.push(0,0xff,0x2f,0);const header=chunk('MThd',[0,0,0,1,ppq>>8,ppq&255]);return new Blob([new Uint8Array([...header,...chunk('MTrk',data)])],{type:'audio/midi'})}
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
function preview(notes){const roll=$('roll');roll.replaceChildren();const minPitch=Math.max(0,Math.min(...notes.map(n=>n.pitchMidi))-2),maxPitch=Math.min(127,Math.max(...notes.map(n=>n.pitchMidi))+2),duration=Math.max(.5,...notes.map(n=>n.endTime));const width=Math.max(660,Math.round(duration*100)),height=(maxPitch-minPitch+1)*13;const NS='http://www.w3.org/2000/svg',svg=document.createElementNS(NS,'svg');svg.setAttribute('width',width);svg.setAttribute('height',height);svg.setAttribute('viewBox',`0 0 ${width} ${height}`);for(let p=minPitch;p<=maxPitch;p++){const rect=document.createElementNS(NS,'rect');rect.setAttribute('x',0);rect.setAttribute('y',(maxPitch-p)*13);rect.setAttribute('width',width);rect.setAttribute('height',13);rect.setAttribute('fill',p%12===0?'#edf0fb':p%2?'#fafbff':'#f4f6fb');svg.append(rect)}for(const n of notes){const rect=document.createElementNS(NS,'rect');rect.setAttribute('x',n.startTime*width/duration);rect.setAttribute('y',(maxPitch-n.pitchMidi)*13+1);rect.setAttribute('width',Math.max(2,(n.endTime-n.startTime)*width/duration));rect.setAttribute('height',11);rect.setAttribute('rx',2);rect.setAttribute('fill','#647ae4');const t=document.createElementNS(NS,'title');t.textContent=`Nota ${n.pitchMidi} · ${n.startTime.toFixed(2)}s–${n.endTime.toFixed(2)}s`;rect.append(t);svg.append(rect)}roll.append(svg);$('stats').textContent=`${notes.length} notas detectadas · ${duration.toFixed(2)} s · Desplázate horizontalmente para verlas.`;$('result').style.display='block'}
$('convert').onclick=async()=>{if(!file||busy)return;stopMidiPlayback();detectedNotes=[];busy=true;$('convert').disabled=true;$('download').disabled=true;try{progress(3);setStatus('Cargando motor de transcripción…');const lib=await import('https://esm.sh/@spotify/basic-pitch@1.0.1?bundle');const {BasicPitch,outputToNotesPoly,addPitchBendsToNoteEvents,noteFramesToTime}=lib;if(!BasicPitch||!outputToNotesPoly)throw Error('La librería no devolvió las funciones necesarias.');progress(12);setStatus('Decodificando audio…');const ctx=new (window.AudioContext||window.webkitAudioContext)();let audio;try{audio=await ctx.decodeAudioData(await file.arrayBuffer())}finally{await ctx.close()}if(audio.duration>180)throw Error('En esta versión utiliza fragmentos de hasta 3 minutos.');progress(16);setStatus('Adaptando audio a 22.050 Hz y mono…');audio=await prepareModelAudio(audio);progress(20);setStatus('Cargando modelo de IA (la primera vez puede tardar)…');const model=new BasicPitch(MODEL_URL);const frames=[],onsets=[],contours=[];setStatus('Detectando notas y acordes…');await model.evaluateModel(audio,(f,o,c)=>{frames.push(...f);onsets.push(...o);contours.push(...c)},p=>{progress(20+Math.round(p*0.7));setStatus(`Analizando audio… ${Math.round(p)}%`)});progress(94);setStatus('Preparando MIDI…');const mode=$('sensitivity').value;const threshold=mode==='sensitive'?.18:mode==='strict'?.38:.25;const raw=outputToNotesPoly(frames,onsets,threshold,threshold,5);const withBends=addPitchBendsToNoteEvents(contours,raw);const notes=noteFramesToTime(withBends).map(n=>({pitchMidi:Math.round(n.pitchMidi),amplitude:n.amplitude,startTime:Math.max(0,n.startTimeSeconds),endTime:Math.max(0,n.startTimeSeconds+n.durationSeconds)})).filter(n=>Number.isFinite(n.pitchMidi)&&Number.isFinite(n.startTime)&&Number.isFinite(n.endTime)&&n.endTime>n.startTime);console.info('Basic Pitch:',{frames:frames.length,rawNotes:raw.length,validNotes:notes.length});if(!notes.length)throw Error(raw.length?'El modelo detectó notas pero ninguna tenía tiempos válidos. Revisa la consola.':'El modelo no detectó notas con estos ajustes. Prueba «Más notas».');midiBlob=midiFromNotes(notes);detectedNotes=notes;preview(notes);$('playMidi').disabled=false;$('download').disabled=false;progress(100);setStatus('¡Listo! MIDI generado en tu navegador.')}catch(err){console.error(err);setStatus('No se pudo convertir: '+(err?.message||String(err))+' Revisa la pestaña Network para ver qué recurso falló.');$('progress').style.display='none'}finally{busy=false;$('convert').disabled=!file}};
$('download').onclick=()=>{if(!midiBlob)return;const url=URL.createObjectURL(midiBlob);const a=document.createElement('a');a.href=url;a.download=(file?.name||'audio').replace(/\.[^.]+$/,'')+'.mid';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000)};

// Beta 1.5: local MIDI note audition using Web Audio. No external soundfont needed.
function stopMidiPlayback(){
  if(midiStopTimer!==null){clearTimeout(midiStopTimer);midiStopTimer=null;}
  for(const voice of midiVoices){try{voice.osc.stop()}catch(e){}try{voice.osc.disconnect();voice.gain.disconnect()}catch(e){}}
  midiVoices=[];
  midiPlaying=false;
  if(midiAudioContext){const ctx=midiAudioContext;midiAudioContext=null;ctx.close().catch(()=>{});}
  if($('playMidi'))$('playMidi').disabled=!detectedNotes.length;
  if($('stopMidi'))$('stopMidi').disabled=true;
  if($('midiPlaybackStatus'))$('midiPlaybackStatus').textContent='Reproducción detenida.';
}
async function playMidiPlayback(){
  if(!detectedNotes.length||midiPlaying)return;
  const ctx=new (window.AudioContext||window.webkitAudioContext)();
  midiAudioContext=ctx;
  try{
    await ctx.resume();
    if(midiAudioContext!==ctx){await ctx.close();return;}
    const startAt=ctx.currentTime+0.08;
    const duration=Math.max(...detectedNotes.map(n=>n.endTime));
    for(const note of detectedNotes){
      const start=Math.max(0,note.startTime),end=Math.max(start+0.02,note.endTime);
      const pitch=Math.max(0,Math.min(127,Math.round(note.pitchMidi)));
      const osc=ctx.createOscillator(),gain=ctx.createGain();
      osc.type='triangle';
      osc.frequency.value=440*Math.pow(2,(pitch-69)/12);
      const volume=Math.max(0.015,Math.min(0.09,(note.amplitude??0.6)*0.08));
      const at=startAt+start,off=startAt+end;
      gain.gain.setValueAtTime(0,at);
      gain.gain.linearRampToValueAtTime(volume,at+Math.min(0.012,(end-start)/3));
      gain.gain.setValueAtTime(volume,Math.max(at+0.012,off-0.035));
      gain.gain.linearRampToValueAtTime(0,off);
      osc.connect(gain);gain.connect(ctx.destination);
      osc.start(at);osc.stop(off+0.015);
      midiVoices.push({osc,gain});
    }
    midiPlaying=true;
    $('playMidi').disabled=true;$('stopMidi').disabled=false;
    $('midiPlaybackStatus').textContent=`Reproduciendo ${detectedNotes.length} notas con sintetizador…`;
    midiStopTimer=setTimeout(()=>{stopMidiPlayback();$('midiPlaybackStatus').textContent='Reproducción finalizada.'},Math.ceil((duration+0.25)*1000));
  }catch(err){stopMidiPlayback();console.error(err);$('midiPlaybackStatus').textContent='No se pudo reproducir: '+(err.message||err);}
}
$('playMidi').onclick=playMidiPlayback;
$('stopMidi').onclick=stopMidiPlayback;

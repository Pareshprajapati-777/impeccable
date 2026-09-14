import { componentPresentation, approveRemaining, componentState, repairStatus, newDraft, submission, summarize, type Box, type Draft, type ReviewPacket, type ReviewHistory } from './model';
import { comparisonSize } from './viewport';
import { styles } from './styles';
import { icon } from './icons';

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const pct = (n: number) => `${n * 100}%`;
// Only trusted adapter URLs may enter frames/images. Never accept javascript: or executable data URLs.
const url = (s: string) => {
  const parsed = new URL(s, location.href);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Unsupported preview URL');
  return esc(parsed.href);
};
export function mountComponentReview(host: HTMLElement, packet: ReviewPacket, options: {
  preview?: boolean; history?: ReviewHistory | null; initialDraft?: Draft; completed?: boolean; onSubmit: (value: ReturnType<typeof submission>) => Promise<void>;
}) {
  const root = host.attachShadow({mode: 'open'});
  let draft = structuredClone(options.initialDraft ?? newDraft(packet));
  const orderedComponents = () => [...packet.components].sort((a,b)=>componentState(a,draft,options.history).priority-componentState(b,draft,options.history).priority);
  let selected = orderedComponents().find(c=>componentState(c,draft,options.history).kind!=='approved')?.id ?? packet.components[0]?.id;
  let inventoryFilter: 'attention' | 'approved' | 'all' = options.completed ? 'all' : 'attention';
  let marking = false;
  let sending = false;
  let submitted = options.completed ?? false;
  let error = '';
  let overlay = false;
  let showAll = false;
  let trayOpen = true;
  let mobilePane: 'comp' | 'component' = 'comp';
  let renderedMobilePane = mobilePane as 'comp' | 'component';
  let zoom: 'fit' | number = 'fit';
  let backdrop: 'checker' | 'page' = 'checker';
  let previousRound = false;
  let outputMode: 'isolated' | 'context' = 'isolated';
  let renderedSelection: string | undefined;
  let renderedZoom: 'fit' | number = 'fit';
  let drag: { x: number; y: number } | null = null;
  let dragBox: Box | null = null;
  let resize: ResizeObserver | null = null;
  const checkIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7"/></svg>';
  const feedbackIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 11 1 2 2-1 7-7-3-3-7 7v2Z"/></svg>';
  const boxStyle = (b: Box) => `left:${pct(b.x)};top:${pct(b.y)};width:${pct(b.w)};height:${pct(b.h)}`;
  function updateDecision(action: 'approve' | 'revise') {
    const c = packet.components.find(c => c.id === selected);
    if (!c) return;
    draft.decisions[c.id] = {revision:c.revision, action, feedback:draft.decisions[c.id]?.feedback ?? '', split: action === 'revise' && (draft.decisions[c.id]?.split ?? false)};
    render();
    if(action==='revise') {
      const field=root.querySelector<HTMLTextAreaElement>('#feedback');
      field?.focus({preventScroll:true});
      const form=root.querySelector<HTMLElement>('.review-form');
      if(form&&field){const overflow=field.getBoundingClientRect().bottom-form.getBoundingClientRect().bottom;if(overflow>0)form.scrollTop+=overflow+8;}
      const pane=root.querySelector<HTMLElement>('.inspection-content');
      const comparison=root.querySelector<HTMLElement>('.compare');
      if(pane&&comparison)pane.scrollTop+=comparison.getBoundingClientRect().top-pane.getBoundingClientRect().top;

    }
  }
  function addMissing(box: Box) {
    const id = `missing-${crypto.randomUUID()}`;
    draft.missing.push({ id, name:'Missing component', feedback:'', box });
    draft.inventoryConfirmed = false;
    selected = id; mobilePane='component'; marking = false; drag = null; dragBox = null;
    render();
    root.querySelector<HTMLInputElement>('#missing-name')?.focus();
  }
  function render() {
    resize?.disconnect();
    const active = root.activeElement as HTMLElement | null;
    const focusId = active?.id;
    const focusSelection = active?.dataset.select;
    const scrollX = window.scrollX, scrollY = window.scrollY;
    const railLeft = root.querySelector('.inventory')?.scrollLeft ?? 0;
    const keepInspector=renderedSelection===selected;
    const focusMobileComparison=mobilePane==='component'&&(!keepInspector||renderedMobilePane!==mobilePane);
    renderedMobilePane=mobilePane;
    const inspectorTop=keepInspector?(root.querySelector('.inspection-content')?.scrollTop??0):0;
    const filesOpen=keepInspector&&(root.querySelector<HTMLDetailsElement>('.changed-files')?.open??false);
    const oldPane=root.querySelector<HTMLElement>('.pan-viewport');
    const retainPan=renderedSelection===selected&&renderedZoom===zoom;
    const panLeft=retainPan?(oldPane?.scrollLeft??0):0, panTop=retainPan?(oldPane?.scrollTop??0):0;
    renderedSelection=selected;renderedZoom=zoom;
    const c = packet.components.find(c => c.id === selected);
    const missing = draft.missing.find(m => m.id === selected);
    const box = c?.box ?? missing?.box;
    const index = c ? packet.components.indexOf(c) + 1 : packet.components.length + draft.missing.findIndex(m => m.id === selected) + 1;
    const savedDecision = c ? draft.decisions[c.id] : undefined;
    const d = savedDecision?.revision === c?.revision ? savedDecision : undefined;
    const stats = summarize(packet, draft);
    const history = options.history;
    const repair = c ? repairStatus(c.id, history) : undefined;
    const priorComponent = history?.packet.components.find(item=>item.id===c?.id);
    const viewingPrevious = previousRound && !!priorComponent;
    const v = viewingPrevious ? priorComponent : c;
    const vp = viewingPrevious ? history!.packet : packet;
    const changes = Object.values(history?.changes??{});
    const changedCount = changes.filter(change=>change.kind==='changed').length;
    const addedCount = changes.filter(change=>change.kind==='added').length;
    const carriedCount = packet.components.filter(item=>componentState(item,draft,history).kind==='approved'&&repairStatus(item.id,history).carried).length;
    const stateFor = (item: typeof packet.components[number]) => componentState(item,draft,history);
    const attentionCount = packet.components.length-stats.approved+draft.missing.length;
    const shownComponents = (inventoryFilter==='attention'?orderedComponents():packet.components).filter(item=>inventoryFilter==='all'||(stateFor(item).kind==='approved')===(inventoryFilter==='approved'));
    const summaryDetails = [
      stats.revisions+draft.missing.length ? `${stats.revisions+draft.missing.length} feedback ready` : '',
      carriedCount ? `${carriedCount} ${carriedCount===1?'approval':'approvals'} kept` : '',
      changedCount ? `${changedCount} changed` : '',
      addedCount ? `${addedCount} added` : '',
      history?.removed.length ? `${history.removed.length} removed` : '',
    ].filter(Boolean).join(' · ');
    const statusMessage = error || (submitted ? (options.preview ? 'Preview submitted. No run changed.' : 'Review submitted.') : stats.hasFeedback ? 'Ready to send for corrections.' : stats.pending ? `${stats.pending} left to review` : !draft.inventoryConfirmed ? 'Confirm the map is complete.' : 'Ready to continue.');
    const presentation = v ? componentPresentation(v) : null;
    const isRaster = v?.preview.kind === 'image' && !presentation?.code;
    const useContext = !!(v?.context && outputMode === 'context');
    const useFrame = v && (useContext ? v.context?.kind !== 'image' : v.preview.kind === 'page');
    const sourceUrl = useContext && v?.context ? v.context.url : v?.preview.url;
    const materialLabel = presentation?.code ? `${presentation.label} · ${presentation.captured ? 'captured from code' : 'live preview'}` : v?.material ? `${v.material.alpha === 'transparent' ? 'Transparent' : v.material.alpha === 'opaque' ? 'Opaque' : 'Transparency unverified'} ${v.material.format}` : 'Raster · transparency unverified';
    root.innerHTML = `<style>${styles}</style><section class="review" aria-label="Component review" style="--comp-background:${/^#[0-9a-f]{6}$/i.test(packet.comp.background ?? '') ? packet.comp.background : '#eeeeee'}">
      <header><div><h1>Review the components.</h1><p>${esc(packet.title)} <span>· Round ${packet.round}</span></p></div>${options.preview ? '<span class="badge">Interactive preview</span>' : ''}</header>
      ${options.preview ? '<p class="preview-note">Historical hotel artwork for testing this interface. Decisions stay in this preview; no run is changed.</p>' : ''}
      ${history ? `<section class="round-summary" aria-label="Changes since previous round"><p><strong>${stats.pending} ${stats.pending===1?'component':'components'} to review</strong><span>${summaryDetails}</span></p>${stats.pending?`<button id="review-changes" class="icon-button" aria-label="Next to review" title="Next to review">${icon('next')}</button>`:''}${history.removed.length?`<details><summary>Removed from the map</summary><p>${history.removed.map(item=>esc(item.name)).join(' · ')}. Confirm these omissions are intentional before accepting the map.</p></details>`:''}</section>`:''}
      <div class="mobile-panes" role="group" aria-label="Inspection view"><button id="show-comp" aria-pressed="${mobilePane==='comp'}">Approved comp</button><button id="show-component" aria-pressed="${mobilePane==='component'}">Component ${index}</button></div>
      <div class="workbench" data-mobile-pane="${mobilePane}"><svg class="connector" aria-hidden="true"><path /></svg>
        <section class="reference" aria-label="Approved composition">
          <div class="section-head"><h2>Approved comp</h2><button id="mark" class="label-icon" aria-pressed="${marking}">${icon(marking?'close':'mark')}${marking ? 'Cancel' : 'Mark missing'}</button></div>
          <div class="map-space"><div class="map ${marking ? 'marking' : ''}" style="aspect-ratio:${packet.comp.width}/${packet.comp.height}">
            <img class="comp" src="${url(packet.comp.url)}" alt="Approved composition for ${esc(packet.title)}" draggable="false">
            ${box ? `<div class="region" style="${boxStyle(box)}"></div>` : ''}
            ${packet.components.map((item,i) => {const state=stateFor(item);return `<button class="pin ${state.kind} ${selected === item.id ? 'selected' : ''}" data-select="${esc(item.id)}" style="left:${pct(Math.min(.96, item.box.x+item.box.w/2))};top:${pct(Math.max(.035,item.box.y))}" aria-label="Inspect ${esc(item.name)} — ${esc(state.label)}" title="${i+1}. ${esc(item.name)} · ${esc(state.label)}" aria-pressed="${selected === item.id}">${state.kind==='approved'?checkIcon:state.kind==='feedback'?feedbackIcon:''}<span>${i+1}</span></button>`}).join('')}
            ${draft.missing.map((item,i)=>`<button class="pin feedback ${selected===item.id?'selected':''}" data-select="${esc(item.id)}" style="left:${pct(item.box.x+item.box.w/2)};top:${pct(item.box.y)}" aria-label="Inspect missing ${esc(item.name)}" title="Missing: ${esc(item.name)}">${feedbackIcon}<span>${packet.components.length+i+1}</span></button>`).join('')}

            <div class="draw-box" hidden></div>
          </div></div>
          <div class="map-legend" aria-label="Map status legend"><span><i class="legend-pending">#</i> To review</span><span><i class="legend-feedback">${feedbackIcon}</i> Feedback ready</span><span><i class="legend-approved">${checkIcon}</i> Approved</span></div>
          ${marking ? '<div class="map-caption">Draw around the missing piece.<button id="add-box">Add an adjustable box</button></div>' : ''}
        </section>
        <section class="inspector" aria-label="Selected component">
          <div class="section-head"><h2><span class="number">${index}</span> ${esc(c?.name ?? missing?.name ?? 'Component')}</h2></div><div class="inspection-content" role="region" aria-label="Component comparison" tabindex="0">
          ${c ? `<div class="material">${icon(presentation!.code ? 'code' : 'image')}<strong>${esc(materialLabel)}</strong><span>${v?.material ? `${v.material.width} × ${v.material.height} px` : ''}</span>${v?.preview.kind==='image'?`<a class="icon-button source-link" href="${url(v!.preview.url)}" target="_blank" rel="noopener" aria-label="${presentation!.fileLabel}" title="${presentation!.fileLabel}">${icon('external')}</a>`:''}</div>
          ${history ? `<div class="repair-context">
            ${repair?.prior?.action==='revise'?`<section class="previous-feedback" aria-label="Previous feedback"><h3>Previous feedback <span>Round ${repair.feedbackRound}</span></h3><p class="previous-verdict">Needs work</p><blockquote>${esc(repair.prior.feedback || 'No written feedback was supplied.')}</blockquote>${repair.prior.split?'<p>Requested: split into separately reviewable components.</p>':''}</section>`:repair?.carried?`<p class="kept-approval">Unchanged · approval kept</p>`:''}
            ${repair?.change?.kind==='changed'?`<details class="changed-files" ${filesOpen?'open':''}><summary>${repair.change.files.length?`${repair.change.files.length} changed ${repair.change.files.length===1?'file':'files'}`:repair.change.reasons.includes('region')?'Region changed':priorComponent?.note!==c.note?'Description changed · files unchanged':'Component definition changed · files unchanged'}</summary>${repair.change.files.length?`<ul>${repair.change.files.map(path=>`<li>${esc(path)}</li>`).join('')}</ul>`:''}${priorComponent&&priorComponent.note!==c.note?`<dl class="description-diff"><dt>Previous description</dt><dd>${esc(priorComponent.note)}</dd><dt>Current description</dt><dd>${esc(c.note)}</dd></dl>`:''}</details>`:''}
          </div>`:''}
          ${priorComponent?`<div class="preview-round"><div class="round-switch" role="group" aria-label="Preview version"><button id="current-round" aria-pressed="${!viewingPrevious}">Current · round ${packet.round}</button><button id="previous-round" aria-pressed="${viewingPrevious}">Previous · round ${history!.packet.round}</button></div></div>`:''}
          <div class="compare-toolbar"><label title="Comparison zoom · based on comp pixels">${icon('zoom')}<select id="zoom" aria-label="Comparison zoom">${[['fit','Fit'],['1','100%'],['2','200%'],['4','400%']].map(([value,label])=>`<option value="${value}" ${String(zoom)===value?'selected':''}>${label}</option>`).join('')}</select></label><button id="overlay" class="overlay-control" aria-pressed="${overlay}"><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="3" width="10" height="10"/><rect x="7" y="7" width="10" height="10"/></svg>Overlay comp</button></div>
          <div class="compare">
            <figure><figcaption>${viewingPrevious ? `Comp · Round ${history!.packet.round}` : 'In the comp'}</figcaption><div class="pan-viewport" aria-label="Reference comparison canvas" tabindex="0"><div class="crop-stage"><img class="crop-image" src="${url(vp.comp.url)}" alt="Reference region for ${esc(v!.name)}" style="width:${100/v!.box.w}%;left:${-100*v!.box.x/v!.box.w}%;top:${-100*v!.box.y/v!.box.h}%"></div></div></figure>
            <figure><figcaption>${viewingPrevious ? `Previous · Round ${history!.packet.round}` : history ? `Current · Round ${packet.round}` : useContext ? 'In the page' : presentation!.caption}</figcaption><div class="pan-viewport" aria-label="Produced comparison canvas" tabindex="0"><div class="output crop-stage ${isRaster&&!useContext&&!useFrame&&backdrop==='checker'?'checker':''}">${!useFrame ? `<img class="asset" src="${url(sourceUrl!)}" alt="Produced ${esc(v!.name)}" style="object-position:${esc(v!.preview.position ?? 'center')}">` : `<iframe aria-hidden="true" title="Rendered ${esc(v!.name)}" src="${url(sourceUrl!)}" sandbox="" tabindex="-1" width="${vp.comp.width}" height="${vp.comp.height}"></iframe>`}${overlay ? `<img class="crop-image overlay-image" src="${url(vp.comp.url)}" alt="Reference overlay" style="width:${100/v!.box.w}%;left:${-100*v!.box.x/v!.box.w}%;top:${-100*v!.box.y/v!.box.h}%">` : ''}</div></div></figure>
          </div>
          ${isRaster ? `<div class="view-controls">${v!.context ? `<div role="group" aria-label="Asset view"><button id="isolated" aria-pressed="${!useContext}">Asset only</button><button id="context" aria-pressed="${useContext}">In page</button></div>` : ''}<div class="background-options" role="group" aria-label="Asset preview background"><button id="background-checker" class="swatch-button" aria-label="Checkerboard background" title="Checkerboard background" aria-pressed="${backdrop==='checker'}" ${useContext?'disabled':''}><span class="background-swatch checker"></span></button><button id="background-page" class="swatch-button" aria-label="${vp.comp.background?'Page color':'Neutral'} background" title="${vp.comp.background?'Page color':'Neutral'} background" aria-pressed="${backdrop==='page'}" ${useContext?'disabled':''}><span class="background-swatch page-swatch"></span></button></div></div>` : ''}
          <div class="component-details"><p class="layering">${esc(v?.context?.layering ?? 'Layer placement not recorded.')}</p>
          <p class="component-note">${esc(v!.note)}</p>
          </div></div><div class="review-form">${viewingPrevious?'<p class="previous-notice">Viewing the previous round. Return to Current to make a decision.</p>':''}<div class="decisions" role="group" aria-label="Decision for ${esc(c.name)}"><div class="decision-title"><strong>Your review <span>Round ${packet.round}</span></strong>${viewingPrevious?'<p>Return to Current to review this round.</p>':''}</div><button id="approve" class="decision-approve ${d?.action === 'approve' ? 'approved' : ''}" aria-pressed="${d?.action === 'approve'}">Looks good</button><button id="revise" class="decision-revise ${d?.action === 'revise' ? 'revise' : ''}" aria-pressed="${d?.action === 'revise'}">Needs work</button>${d ? `<button id="clear" class="quiet icon-button" aria-label="Clear decision" title="Clear decision">${icon('undo')}</button>` : ''}</div>
          ${d?.action === 'revise' ? `<label class="feedback">New feedback <span>Optional</span><textarea id="feedback" placeholder="What still needs to change in this version?">${esc(d.feedback)}</textarea></label><label class="check"><input id="split" type="checkbox" ${d.split ? 'checked' : ''}> Split into separately reviewable components</label>` : ''}
          </div>` : missing ? `<p>This piece will be added to the unresolved inventory.</p><label class="feedback">Name<input id="missing-name" value="${esc(missing.name)}"></label><label class="feedback">What is missing?<textarea id="missing-feedback">${esc(missing.feedback)}</textarea></label><div class="coordinates">${(['x','y','w','h'] as const).map(k=>`<label>${{x:'Left',y:'Top',w:'Width',h:'Height'}[k]} %<input type="number" data-coordinate="${k}" value="${Math.round(missing.box[k]*1000)/10}" min="0" max="100" step="0.1"></label>`).join('')}</div><button id="remove-missing">Remove this mark</button></div>` : '<p>No components supplied.</p></div>'}
        </section>
      </div>
      <section class="inventory-section ${trayOpen?'':'tray-collapsed'} ${showAll&&trayOpen?'tray-expanded':''}" aria-label="Component inventory"><div class="section-head"><h2>Components</h2><div class="inventory-filters" role="group" aria-label="Filter components"><button data-filter="attention" aria-pressed="${inventoryFilter==='attention'}">Needs attention <b>${attentionCount}</b></button><button data-filter="approved" aria-pressed="${inventoryFilter==='approved'}">Approved <b>${stats.approved}</b></button><button data-filter="all" aria-pressed="${inventoryFilter==='all'}">All <b>${packet.components.length+draft.missing.length}</b></button></div><div class="tray-actions"><button id="show-all" class="icon-button" aria-pressed="${showAll}" aria-controls="component-tray" aria-label="${showAll?'Compact':'Expand'} tray" title="${showAll?'Compact':'Expand'} tray">${icon(showAll?'compact':'expand')}</button><button id="toggle-tray" class="icon-button" aria-expanded="${trayOpen}" aria-controls="component-tray" aria-label="${trayOpen?'Hide':'Show'} component tray" title="${trayOpen?'Hide':'Show'} component tray">${icon(trayOpen?'hideTray':'showTray')}</button></div></div>
      <div id="component-tray" class="inventory ${showAll ? 'all' : ''}">${shownComponents.map(item=>{const i=packet.components.indexOf(item);const state=stateFor(item); return `<button class="item ${state.kind} ${selected === item.id ? 'active' : ''}" data-select="${esc(item.id)}" aria-pressed="${selected === item.id}">${item.thumbnail ? `<span class="item-thumb">${item.thumbnail.box ? `<span class="thumb-crop" style="width:min(100%,${76*item.thumbnail.box.w*packet.comp.width/(item.thumbnail.box.h*packet.comp.height)}px);aspect-ratio:${item.thumbnail.box.w*packet.comp.width}/${item.thumbnail.box.h*packet.comp.height}"><img alt="" loading="lazy" src="${url(item.thumbnail.url)}" style="position:absolute;width:${100/item.thumbnail.box.w}%;max-width:none;left:${-100*item.thumbnail.box.x/item.thumbnail.box.w}%;top:${-100*item.thumbnail.box.y/item.thumbnail.box.h}%;"></span>` : `<img alt="" loading="lazy" src="${url(item.thumbnail.url)}">`}</span>` : ''}<span class="item-number">${state.kind==='approved'?checkIcon:state.kind==='feedback'?feedbackIcon:''}${i+1}<span class="item-medium">${icon(componentPresentation(item).code ? 'code' : 'image')}${esc(componentPresentation(item).label)}</span></span><strong>${esc(item.name)}</strong><span class="state ${state.kind}">${esc(state.label)}</span></button>`}).join('')}${(inventoryFilter==='approved'?[]:draft.missing).map((m,i)=>`<button class="item feedback ${selected===m.id?'active':''}" data-select="${esc(m.id)}"><span class="item-number">${packet.components.length+i+1}</span><strong>${esc(m.name)}</strong><span class="state revise">Missing</span></button>`).join('')}${!shownComponents.length&&(inventoryFilter==='approved'||!draft.missing.length)?`<p class="inventory-empty">${inventoryFilter==='attention'?'Every component is approved. Confirm the map is complete, then continue.':'No components approved yet.'}</p>`:''}</div></section>
      <footer><div><button id="approve-rest" ${!stats.pending ? 'disabled' : ''}>Approve ${stats.approved || stats.revisions ? 'remaining' : 'all'}</button><label class="check"><input id="inventory-confirm" type="checkbox" ${draft.inventoryConfirmed?'checked':''}> Nothing missing from the comp</label></div><div class="submit-area"><p role="status">${esc(statusMessage)}</p><button id="submit" class="primary" ${!stats.canSubmit || sending || submitted?'disabled':''}>${sending?'Sending…':stats.hasFeedback?'Send feedback':'Approve & continue'}</button></div></footer>
    </section>`;
    if(viewingPrevious)root.querySelectorAll<HTMLButtonElement|HTMLInputElement|HTMLTextAreaElement>('.decisions button,#feedback,#split,#approve-rest,#submit,#inventory-confirm').forEach(el=>el.disabled=true);
    root.querySelector('.inspection-content')!.scrollTop=inspectorTop;
    if(submitted||sending)root.querySelectorAll<HTMLButtonElement|HTMLInputElement|HTMLTextAreaElement>('.decisions button,#approve-rest,#mark,#inventory-confirm,#missing-name,#missing-feedback,#feedback,#split,#remove-missing,[data-coordinate]').forEach(el=>el.disabled=true);
    root.querySelector('.inventory')!.scrollLeft = railLeft;
    if(!keepInspector&&trayOpen)Array.from(root.querySelectorAll<HTMLElement>('.inventory [data-select]')).find(el=>el.dataset.select===selected)?.scrollIntoView({block:'nearest',inline:'nearest'});
    if (focusId) root.getElementById(focusId)?.focus({preventScroll:true});
    else if(focusSelection) Array.from(root.querySelectorAll<HTMLElement>('.item[data-select]')).find(el=>el.dataset.select===focusSelection)?.focus({preventScroll:true});
    const on = (id:string, action:()=>void) => root.querySelector(`#${id}`)?.addEventListener('click', action);
    root.querySelectorAll<HTMLElement>('[data-select]').forEach(el => el.onclick = () => {if(marking)return; selected=el.dataset.select!; mobilePane='component'; overlay=false; zoom='fit'; outputMode='isolated'; previousRound=false; render();});
    on('previous-round',()=>{previousRound=true;render();});
    on('current-round',()=>{previousRound=false;render();});
    on('review-changes',()=>{const pending=orderedComponents().filter(item=>stateFor(item).kind==='pending');const current=pending.findIndex(item=>item.id===selected);const next=pending[(current+1)%pending.length];if(next){selected=next.id;mobilePane='component';inventoryFilter='attention';previousRound=false;zoom='fit';overlay=false;outputMode='isolated';render();}});
    root.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach(button=>button.onclick=()=>{
      inventoryFilter=button.dataset.filter as typeof inventoryFilter;
      const matches=orderedComponents().filter(item=>inventoryFilter==='all'||(stateFor(item).kind==='approved')===(inventoryFilter==='approved'));
      const selectedMissing=inventoryFilter!=='approved'&&draft.missing.some(item=>item.id===selected);
      if(!selectedMissing&&!matches.some(item=>item.id===selected)&&matches.length){selected=matches[0].id;mobilePane='component';previousRound=false;zoom='fit';overlay=false;outputMode='isolated';}
      render();
    });
    on('approve',()=>updateDecision('approve')); on('revise',()=>updateDecision('revise'));
    on('clear',()=>{if(c)delete draft.decisions[c.id]; render();});
    on('overlay',()=>{overlay=!overlay; render();});
    on('isolated',()=>{outputMode='isolated';render();});
    on('context',()=>{outputMode='context';render();});
    root.querySelector('#zoom')?.addEventListener('change',e=>{const value=(e.target as HTMLSelectElement).value;zoom=value==='fit'?'fit':Number(value);render();});
    on('background-checker',()=>{backdrop='checker';render();});
    on('background-page',()=>{backdrop='page';render();});
    on('show-all',()=>{showAll=!showAll;trayOpen=true;render();});
    on('toggle-tray',()=>{trayOpen=!trayOpen;render();});
    on('show-comp',()=>{mobilePane='comp';render();});
    on('show-component',()=>{mobilePane='component';render();});
    on('mark',()=>{marking=!marking;render();}); on('add-box',()=>addMissing({x:.35,y:.35,w:.2,h:.2}));
    on('remove-missing',()=>{draft.missing=draft.missing.filter(m=>m.id!==selected);selected=packet.components[0]?.id;render();});
    on('approve-rest',()=>{draft=approveRemaining(packet,draft);render();});
    root.querySelector('#inventory-confirm')?.addEventListener('change',e=>{draft.inventoryConfirmed=(e.target as HTMLInputElement).checked;render();});
    root.querySelector('#feedback')?.addEventListener('input',e=>{if(c)draft.decisions[c.id].feedback=(e.target as HTMLTextAreaElement).value;});
    root.querySelector('#split')?.addEventListener('change',e=>{if(c)draft.decisions[c.id].split=(e.target as HTMLInputElement).checked;});
    root.querySelector('#missing-name')?.addEventListener('input',e=>{if(missing)missing.name=(e.target as HTMLInputElement).value; const submit=root.querySelector<HTMLButtonElement>('#submit');if(submit)submit.disabled=!summarize(packet,draft).canSubmit;});
    root.querySelector('#missing-feedback')?.addEventListener('input',e=>{if(missing)missing.feedback=(e.target as HTMLTextAreaElement).value;});
    root.querySelectorAll<HTMLInputElement>('[data-coordinate]').forEach(el=>el.addEventListener('change',()=>{
      if(!missing)return; const k=el.dataset.coordinate as keyof Box;
      const next=Number(el.value)/100;
      if(Number.isFinite(next)) missing.box[k]=Math.max(k==='w'||k==='h'?.001:0, Math.min(1,next));
      missing.box.w=Math.min(missing.box.w,1-missing.box.x);missing.box.h=Math.min(missing.box.h,1-missing.box.y);render();
    }));
    on('submit',async()=>{sending=true;error='';render();try{await options.onSubmit(submission(packet,draft));submitted=true;}catch(e){error=e instanceof Error?e.message:'Could not save. Try again.';}finally{sending=false;render();}});
    const map = root.querySelector<HTMLElement>('.map')!;
    function point(e: PointerEvent) {const r=map.getBoundingClientRect();return {x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))};}
    map.addEventListener('pointerdown',e=>{if(!marking)return;drag=point(e);map.setPointerCapture(e.pointerId);e.preventDefault();});
    map.addEventListener('pointermove',e=>{if(!drag)return;const p=point(e);dragBox={x:Math.min(drag.x,p.x),y:Math.min(drag.y,p.y),w:Math.abs(p.x-drag.x),h:Math.abs(p.y-drag.y)};const outline=root.querySelector<HTMLElement>('.draw-box')!;outline.hidden=false;outline.style.cssText=boxStyle(dragBox);});
    map.addEventListener('pointerup',()=>{if(dragBox&&dragBox.w>.01&&dragBox.h>.01)addMissing(dragBox);else{drag=null;dragBox=null;}});
    map.addEventListener('pointercancel',()=>{drag=null;dragBox=null;render();});
    const stage=root.querySelector<HTMLElement>('.output'); const frame=root.querySelector<HTMLIFrameElement>('iframe');
    const workbench=root.querySelector<HTMLElement>('.workbench')!;
    // Reflect native scroll position without re-rendering or resetting the inspector.
    const inspectionBody=root.querySelector<HTMLElement>('.inspection-content');
    const inspectionPanel=root.querySelector<HTMLElement>('.inspector');
    function updateScrollEdges() {
      if(!inspectionBody||!inspectionPanel)return;
      inspectionPanel.dataset.scrollAbove=String(inspectionBody.scrollTop>1);
      inspectionPanel.dataset.scrollBelow=String(inspectionBody.scrollHeight-inspectionBody.clientHeight-inspectionBody.scrollTop>1);
    }
    inspectionBody?.addEventListener('scroll',updateScrollEdges,{passive:true});
    function resizePreview() {
      const mapSpace=root.querySelector<HTMLElement>('.map-space');
      if(mapSpace&&mapSpace.clientWidth&&mapSpace.clientHeight){
        const fit=comparisonSize(packet.comp.width,packet.comp.height,Math.max(1,mapSpace.clientWidth-32),Math.max(1,mapSpace.clientHeight-32),'fit');
        map.style.width=`${fit.width}px`;map.style.height=`${fit.height}px`;
      }
      const content=root.querySelector<HTMLElement>('.inspection-content');
      const panes=Array.from(root.querySelectorAll<HTMLElement>('.pan-viewport'));
      if(content?.clientHeight)panes.forEach(p=>p.style.height=`${Math.min(248,Math.max(100,content.clientHeight-40))}px`);
      if(v&&panes.length){const size=comparisonSize(v.box.w*vp.comp.width,v.box.h*vp.comp.height,Math.min(...panes.map(p=>p.clientWidth)),Math.min(...panes.map(p=>p.clientHeight)),zoom);root.querySelectorAll<HTMLElement>('.crop-stage').forEach(el=>{el.style.width=`${size.width}px`;el.style.height=`${size.height}px`;});}
      if(stage&&frame&&v){const s=stage.clientWidth/(v.box.w*vp.comp.width);frame.style.transform=`scale(${s})`;frame.style.left=`${-v.box.x*vp.comp.width*s}px`;frame.style.top=`${-v.box.y*vp.comp.height*s}px`;}
      const bounds=workbench.getBoundingClientRect();const region=root.querySelector<HTMLElement>('.region');const end=root.querySelector<HTMLElement>('.number');
      const path=root.querySelector<SVGPathElement>('.connector path');
      if(region&&end&&path){const a=region.getBoundingClientRect(),b=end.getBoundingClientRect();const x1=a.right-bounds.left,y1=a.top+a.height/2-bounds.top,x2=b.left-bounds.left-8,y2=b.top+b.height/2-bounds.top;path.setAttribute('d',`M ${x1} ${y1} H ${x2-14} V ${y2} H ${x2}`);}
    }
    resize=new ResizeObserver(()=>{resizePreview();updateScrollEdges();});resize.observe(workbench);const content=root.querySelector('.inspection-content');if(content)resize.observe(content);resizePreview();
    const panes=Array.from(root.querySelectorAll<HTMLElement>('.pan-viewport'));
    panes.forEach(pane=>{pane.scrollLeft=panLeft;pane.scrollTop=panTop;});
    panes.forEach(pane=>pane.addEventListener('scroll',()=>{for(const other of panes)if(other!==pane){if(other.scrollLeft!==pane.scrollLeft)other.scrollLeft=pane.scrollLeft;if(other.scrollTop!==pane.scrollTop)other.scrollTop=pane.scrollTop;}}));
    if(focusMobileComparison&&window.matchMedia('(max-width:800px)').matches){const body=root.querySelector<HTMLElement>('.inspection-content');const comparison=root.querySelector<HTMLElement>('.compare');if(body&&comparison)body.scrollTop+=comparison.getBoundingClientRect().top-body.getBoundingClientRect().top;}
    updateScrollEdges();
    window.scrollTo(scrollX,scrollY);
  }
  render();
  return {destroy(){resize?.disconnect();root.replaceChildren();},getDraft():Draft{return structuredClone(draft);}};
}

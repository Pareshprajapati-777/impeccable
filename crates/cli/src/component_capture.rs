//! Native component previews over the shared frozen-input/CDP capture foundation.
//! This records provenance and pixels; visual acceptance remains a separate human decision.
use base64::Engine;
use impeccable_browser::{
    cdp::{Browser, Viewport},
    discovery,
    html_snapshot::HtmlSnapshot,
};
use impeccable_context::component_review::capture::{CapturedPreviews, ComponentCapturer};
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Arc, time::Duration};

pub struct NativeComponentCapturer;
fn hash(bytes: &[u8]) -> String {
    // The PNG module and review store use the same SHA-256; avoid a second hash contract.
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}
fn source(view: &Value) -> Result<&str, String> {
    view["url"]
        .as_str()
        .and_then(|s| s.strip_prefix("/files/"))
        .ok_or_else(|| "preview needs a pinned source".into())
}
fn material(png: &[u8], format: &str) -> Result<Value, String> {
    if !impeccable_comp::png_io::is_png(png) || png.len() < 24 {
        return Err("native review currently requires PNG raster assets".into());
    }
    let width = u32::from_be_bytes(png[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(png[20..24].try_into().unwrap());
    if u64::from(width) * u64::from(height) > 32_000_000 {
        return Err("preview exceeds 32 megapixels".into());
    }
    let image = impeccable_comp::png_io::decode_png(png)?.image;
    Ok(
        json!({"format":format,"width":image.width,"height":image.height,"alpha":if image.data.chunks_exact(4).any(|p|p[3]<255){"transparent"}else{"opaque"}}),
    )
}
fn render_page(
    browser: &mut Browser,
    snapshot: Arc<HtmlSnapshot>,
    width: u32,
    height: u32,
    box_: &Value,
) -> Result<(Vec<u8>, Value), String> {
    let server = snapshot.serve()?;
    let url = server.entry_url();
    let origin = url.split('/').take(3).collect::<Vec<_>>().join("/");
    let mut page = browser.new_page().map_err(|e| e.message)?;
    let result = (|| {
        page.set_viewport(Viewport { width, height })
            .map_err(|e| e.message)?;
        page.set_reduced_motion(true).map_err(|e| e.message)?;
        page.begin_response_capture().map_err(|e| e.message)?;
        page.goto(&url, "networkidle0", Duration::from_secs(20))
            .map_err(|e| e.message)?;
        let world = page.create_isolated_world().map_err(|e| e.message)?;
        let dom=page.evaluate_value_in_world(&world,r#"(async()=>{
          if(document.scripts.length||document.querySelector('iframe,frame,object,embed,canvas'))throw Error('Component capture requires static HTML/CSS/SVG; script, frame and canvas components need a supported capture adapter.');
          await Promise.race([(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode()));})(),new Promise((_,reject)=>setTimeout(()=>reject(Error('component resources did not settle')),5000))]);
          if([...document.fonts].some(f=>f.status==='error'))throw Error('A component font failed to load.');
          if(document.getAnimations().some(a=>a.playState==='running'))throw Error('Component is animated; provide its static review state.');
          return {html:document.documentElement.outerHTML,svg:document.querySelectorAll('svg').length,images:document.images.length,controls:document.querySelectorAll('button,input,select,textarea,a[href]').length};
        })()"#).map_err(|e|e.message)?;
        let coords = ["x", "y", "w", "h"].map(|k| box_[k].as_f64().unwrap());
        let clip = [
            coords[0] * width as f64,
            coords[1] * height as f64,
            coords[2] * width as f64,
            coords[3] * height as f64,
        ];
        let first = page
            .screenshot_clip(clip[0], clip[1], clip[2], clip[3])
            .map_err(|e| e.message)?;
        let urls = page.observed_response_urls().map_err(|e| e.message)?;
        let evidence = page.response_evidence(&urls).map_err(|e| e.message)?;
        if evidence.truncated
            || evidence.changed_during_collection
            || !evidence.missing_urls.is_empty()
        {
            return Err("component network evidence is incomplete".into());
        }
        let mut responses = BTreeMap::new();
        for record in &evidence.responses {
            if record.url.starts_with("data:image/") {
                continue;
            }
            if record.url == format!("{origin}/favicon.ico")
                && record.status == Some(404.)
                && snapshot.bytes("favicon.ico").is_none()
            {
                continue;
            }
            let target = record
                .url
                .strip_prefix(&origin)
                .ok_or("component requested an external dependency")?;
            let path = snapshot
                .serve_path(target)
                .ok_or_else(|| format!("undeclared component dependency: {target}"))?;
            let expected = snapshot.bytes(&path).ok_or("missing frozen dependency")?;
            if record.status != Some(200.)
                || !record.complete
                || record.from_service_worker
                || record.ambiguous_url
                || record.body.as_deref() != Some(expected)
            {
                return Err(format!(
                    "component dependency did not match frozen bytes: {path}"
                ));
            }
            responses.insert(path, hash(expected));
        }
        if !responses.contains_key(snapshot.entry()) {
            return Err("component document response is unverified".into());
        }
        let second = page
            .screenshot_clip(clip[0], clip[1], clip[2], clip[3])
            .map_err(|e| e.message)?;
        let after = page.response_evidence(&urls).map_err(|e| e.message)?;
        if first != second || after.revision != evidence.revision || after.changed_during_collection
        {
            return Err("component changed during capture".into());
        }
        // Identity comes from the isolated document, never a producer-written receipt.
        let unchanged = page
            .evaluate_value_in_world(&world, "document.documentElement.outerHTML")
            .map_err(|e| e.message)?;
        if unchanged != dom["html"] {
            return Err("component document changed during capture".into());
        }
        let png = base64::engine::general_purpose::STANDARD
            .decode(first)
            .map_err(|e| e.to_string())?;
        let proof = json!({"kind":"static-code","entry":snapshot.entry(),"inputSnapshot":snapshot.digest(),"inputs":snapshot.manifest(),"observedDependencies":responses,"domSha256":hash(dom["html"].as_str().unwrap().as_bytes()),"screenshotSha256":hash(&png),"viewport":{"width":width,"height":height,"dpr":1},"box":box_,"reducedMotion":true,"svgElements":dom["svg"],"rasterElements":dom["images"],"semanticControls":dom["controls"]});
        Ok((png, proof))
    })();
    page.close();
    result
}
impl ComponentCapturer for NativeComponentCapturer {
    fn capture(
        &mut self,
        packet: &mut Value,
        inputs: &BTreeMap<String, Vec<u8>>,
    ) -> Result<CapturedPreviews, String> {
        let width = packet["comp"]["width"]
            .as_u64()
            .ok_or("missing comp width")? as u32;
        let height = packet["comp"]["height"]
            .as_u64()
            .ok_or("missing comp height")? as u32;
        if u64::from(width) * u64::from(height) > 16_000_000 {
            return Err("component viewport exceeds 16 megapixels".into());
        }
        let reference = inputs
            .get(source(&packet["comp"])?)
            .ok_or("missing approved reference")?;
        let reference_size = material(reference, "PNG")?;
        if reference_size["width"] != width || reference_size["height"] != height {
            return Err("comp dimensions do not match its PNG".into());
        }
        let env = std::env::vars().collect();
        let exe =
            discovery::find_browser(&env).map_err(|e| format!("browser unavailable: {e:?}"))?;
        let mut browser = Browser::launch(&exe, &[], false).map_err(|e| e.message)?;
        let version = browser.version().map_err(|e| e.message)?;
        let result = (|| {
            let mut files = BTreeMap::new();
            let mut evidence = Vec::new();
            // Reuse captures across regions sharing a source and geometry, never across changed inputs.
            let mut cache: BTreeMap<String, (Vec<u8>, Value)> = BTreeMap::new();
            for c in packet["components"]
                .as_array_mut()
                .ok_or("missing components")?
            {
                let id = c["id"].as_str().ok_or("missing component id")?.to_string();
                let mut views = serde_json::Map::new();
                for key in ["preview", "context"] {
                    if c.get(key).is_none() {
                        continue;
                    }
                    let path = source(&c[key])?.to_string();
                    if key == "preview" && c[key]["kind"] == "image" {
                        let bytes = inputs.get(&path).ok_or("missing raster source")?;
                        c["material"] = material(bytes, "PNG")?;
                        views.insert(
                            key.into(),
                            json!({"kind":"raster-source","path":path,"sha256":hash(bytes)}),
                        );
                        continue;
                    }
                    let mut selected = BTreeMap::new();
                    for name in c["dependencies"]
                        .as_array()
                        .ok_or("missing dependencies")?
                        .iter()
                        .filter_map(Value::as_str)
                        .chain(std::iter::once(path.as_str()))
                    {
                        selected.insert(
                            name.into(),
                            inputs.get(name).ok_or("missing pinned dependency")?.clone(),
                        );
                    }
                    let snapshot = Arc::new(HtmlSnapshot::from_pinned(path.clone(), selected)?);
                    let cache_key = format!("{}:{}", snapshot.digest(), c["box"]);
                    let (png, proof) = if let Some(saved) = cache.get(&cache_key) {
                        saved.clone()
                    } else {
                        let captured =
                            render_page(&mut browser, snapshot, width, height, &c["box"])
                                .map_err(|e| format!("{id} {key}: {e}"))?;
                        cache.insert(cache_key, captured.clone());
                        captured
                    };
                    let output = format!("_review_captures/{}.png", hash(&png));
                    c[key]["url"] = json!(format!("/files/{output}"));
                    c[key]["kind"] = json!("image");
                    c[key]["sourceKind"] = json!("page");
                    if key == "preview" {
                        c["material"] = material(&png, "Captured HTML / CSS / SVG")?;
                    }
                    views.insert(key.into(), proof);
                    files.insert(output, png);
                }
                // Thumbnails must show exactly the reviewable output, not a separate producer image.
                c["thumbnail"] = json!({"url":c["preview"]["url"]});
                evidence.push(json!({"id":id,"views":views}));
            }
            Ok(CapturedPreviews {
                files,
                evidence: json!({"schema":"native-component-previews-v1","browser":version,"components":evidence,"scope":"Pinned raster sources and static HTML/CSS/SVG captures. No visual, semantic or human-identity approval."}),
            })
        })();
        browser.close();
        result
    }
}

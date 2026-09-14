use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Component, Path, PathBuf},
};

pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn string<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("missing {key}"))
}
pub fn relative(value: &str) -> Result<PathBuf, String> {
    let p = Path::new(value);
    if p.is_absolute()
        || value.contains(['\\', '?', '#', '%', ':'])
        || !p.components().all(|c| matches!(c, Component::Normal(_)))
    {
        return Err(format!("expected a plain project-relative path: {value}"));
    }
    Ok(p.to_path_buf())
}
pub fn valid_box(v: &Value) -> bool {
    let a: Option<Vec<f64>> = ["x", "y", "w", "h"]
        .iter()
        .map(|k| v.get(k).and_then(Value::as_f64))
        .collect();
    a.map(|a| {
        a.iter().all(|n| n.is_finite())
            && a[0] >= 0.
            && a[1] >= 0.
            && a[2] > 0.
            && a[3] > 0.
            && a[0] + a[2] <= 1.00001
            && a[1] + a[3] <= 1.00001
    })
    .unwrap_or(false)
}
fn pin(
    project: &Path,
    path: &str,
    files: &mut BTreeMap<String, Vec<u8>>,
) -> Result<String, String> {
    let rel = relative(path)?;
    let full = project
        .join(rel)
        .canonicalize()
        .map_err(|e| format!("{path}: {e}"))?;
    if !full.starts_with(project) || !full.is_file() {
        return Err(format!("file escapes project: {path}"));
    }
    let size = std::fs::metadata(&full).map_err(|e| e.to_string())?.len();
    if size > 32 * 1024 * 1024 {
        return Err(format!("file exceeds 32 MiB: {path}"));
    }
    let bytes = std::fs::read(full).map_err(|e| e.to_string())?;
    if files.values().map(Vec::len).sum::<usize>() + bytes.len() > 256 * 1024 * 1024 {
        return Err("review exceeds 256 MiB".into());
    }
    let hash = digest(&bytes);
    files.insert(path.into(), bytes);
    Ok(hash)
}
fn view(
    v: &mut Value,
    project: &Path,
    files: &mut BTreeMap<String, Vec<u8>>,
    used: &mut BTreeMap<String, String>,
) -> Result<(), String> {
    let p = string(v, "path")?.to_string();
    let hash = pin(project, &p, files)?;
    used.insert(p.clone(), hash);
    v.as_object_mut()
        .ok_or("preview must be an object")?
        .remove("path");
    v["url"] = json!(format!("/files/{p}"));
    Ok(())
}
/// Producer declares the dependency closure. Capturer verification is a separate gate;
/// pinning a supplied screenshot is not proof that it was captured from these sources.
pub fn freeze(project: &Path, input: &Value) -> Result<(Value, BTreeMap<String, Vec<u8>>), String> {
    let canonical = project.canonicalize().map_err(|e| e.to_string())?;
    let project = canonical.as_path();
    if input["schemaVersion"] != 1 {
        return Err("manifest schemaVersion must be 1".into());
    }
    let mut packet = input.clone();
    for key in ["capture", "captureVerified"] {
        packet
            .as_object_mut()
            .ok_or("manifest must be an object")?
            .remove(key);
    }
    string(input, "id")?;
    string(input, "title")?;
    if input["id"].as_str().unwrap().len() > 160 {
        return Err("id too long".into());
    }
    for k in ["width", "height"] {
        if !input["comp"][k]
            .as_u64()
            .is_some_and(|n| n > 0 && n <= 16384)
        {
            return Err(format!("invalid comp {k}"));
        }
    }
    let mut files = BTreeMap::new();
    let mut comp_files = BTreeMap::new();
    // The component inventory is measured against this spec. Bind it centrally
    // rather than requiring every component author to repeat this dependency.
    if input["stage"] == "components" {
        let spec_path = ".impeccable/build/spec.json";
        comp_files.insert(spec_path.into(), pin(project, spec_path, &mut files)?);
        let spec: Value = serde_json::from_slice(&files[spec_path]).map_err(|e| e.to_string())?;
        for region in spec["regions"].as_array().ok_or("measured spec needs regions")? {
            let component = input["components"].as_array().and_then(|items| items.iter().find(|c| c["id"] == region["id"]))
                .ok_or_else(|| format!("component review omitted measured region {}", region["id"]))?;
            if matches!(region["kind"].as_str(), Some("text" | "control")) && component["preview"]["kind"] != "page" {
                return Err(format!("semantic region {} requires a rendered code preview", region["id"]));
            }
        }
    }

    view(&mut packet["comp"], project, &mut files, &mut comp_files)?;
    let mut ids = BTreeSet::new();
    let components = packet["components"]
        .as_array_mut()
        .ok_or("components must be an array")?;
    if components.is_empty() || components.len() > 200 {
        return Err("supply 1–200 components".into());
    }
    for c in components {
        for key in ["capture", "captureVerified"] {
            c.as_object_mut()
                .ok_or("component must be an object")?
                .remove(key);
        }
        for key in ["preview", "context", "thumbnail"] {
            if let Some(view) = c.get_mut(key).and_then(Value::as_object_mut) {
                view.remove("sourceKind");
                view.remove("capture");
            }
        }
        let id = string(c, "id")?.to_string();
        if !ids.insert(id) || !valid_box(&c["box"]) {
            return Err("duplicate component or invalid box".into());
        }
        for k in ["name", "medium", "note"] {
            if !c[k].is_string() {
                return Err(format!("component needs {k}"));
            }
        }
        if !matches!(c["preview"]["kind"].as_str(), Some("image" | "page")) {
            return Err("preview kind must be image or page".into());
        }
        let deps = c["dependencies"]
            .as_array()
            .ok_or("each component must declare its dependencies array")?
            .clone();
        let mut used = comp_files.clone();
        for dep in deps {
            let p = dep.as_str().ok_or("dependency must be a path")?;
            used.insert(p.into(), pin(project, p, &mut files)?);
        }
        let preview_path = string(&c["preview"], "path")?.to_string();
        view(&mut c["preview"], project, &mut files, &mut used)?;
        c.as_object_mut().unwrap().remove("material");
        if c["preview"]["kind"] == "image" {
            let bytes = &files[&preview_path];
            if impeccable_comp::png_io::is_png(bytes) {
                if bytes.len() < 24 {
                    return Err("truncated PNG".into());
                }
                let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
                let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
                if u64::from(width) * u64::from(height) > 32_000_000 {
                    return Err("PNG exceeds 32 megapixels".into());
                }
                let image = impeccable_comp::png_io::decode_png(bytes)?.image;
                let transparent = image.data.chunks_exact(4).any(|p| p[3] < 255);
                c["material"] = json!({"format":"PNG","width":image.width,"height":image.height,"alpha":if transparent{"transparent"}else{"opaque"}});
            }
        }
        for k in ["context", "thumbnail"] {
            if c.get(k).is_some() {
                if let Some(b) = c[k].get("box") {
                    if !valid_box(b) {
                        return Err("invalid thumbnail box".into());
                    }
                }
                view(&mut c[k], project, &mut files, &mut used)?;
            }
        }
        c.as_object_mut().unwrap().remove("revision");
        c["revision"] = json!(digest(
            &serde_json::to_vec(&json!({"component":c,"files":used})).unwrap()
        ));
    }
    let total: usize = files.values().map(Vec::len).sum();
    if total > 256 * 1024 * 1024 {
        return Err("review exceeds 256 MiB".into());
    }
    packet.as_object_mut().unwrap().remove("revision");
    packet.as_object_mut().unwrap().remove("round");
    let revision = digest(&serde_json::to_vec(&packet).unwrap());
    packet["revision"] = json!(revision);
    Ok((packet, files))
}

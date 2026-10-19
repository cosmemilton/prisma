# Added in this experimental Firebird fork; see MODIFICATIONS.md.
"""Read existing offline Cargo evidence and preserve observed runtime license files."""
from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
import tomllib


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def file_evidence(path: Path) -> dict:
    return {"path": str(path), "fileName": path.name, "bytes": path.stat().st_size, "sha256": sha256(path)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--engines-root", type=Path, required=True)
    parser.add_argument("--resolver-evidence", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cargo-home", type=Path, required=True)
    parser.add_argument("--wasm-artifact", type=Path)
    parser.add_argument("--additional-wasm-artifact", type=Path, action="append", default=[])
    args = parser.parse_args()
    engines = args.engines_root.resolve(strict=True)
    evidence = args.resolver_evidence.resolve(strict=True)
    output = args.output.resolve()
    candidate_root = engines / "target" / "query-compiler-wasm"
    license_root = candidate_root / "third-party-licenses"
    assert license_root.resolve().is_relative_to((engines / "target").resolve())
    metadata_path = evidence / "wasm-runtime-metadata.json"
    normal_path = evidence / "wasm-runtime-tree.txt"
    build_path = evidence / "wasm-build-input-tree.txt"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8-sig"))
    package_index = defaultdict(list)
    packages = {}
    for package in metadata["packages"]:
        package_index[package["name"], package["version"]].append(package)
        packages[package["id"]] = package
    locked = tomllib.loads((engines / "Cargo.lock").read_text(encoding="utf-8"))
    locked_index = defaultdict(list)
    for package in locked["package"]:
        locked_index[package["name"], package["version"]].append(package)
    unresolved = []
    fallback_ids = set()
    label_cache = {}

    def resolve_package(name: str, version: str, suffix: str) -> dict:
        label = name, version, suffix
        if label in label_cache:
            return label_cache[label]
        candidates = package_index[name, version]
        if len(candidates) > 1:
            candidates = [p for p in candidates if str(Path(p["manifest_path"]).parent) in suffix
                          or (p.get("source") and p["source"].removeprefix("git+").split("#")[0] in suffix)]
        if len(candidates) != 1:
            # Target-filtered workspace metadata can omit host-only packages. Read
            # only this selected, locked crate's cached manifest, never the full cache.
            locks = locked_index[name, version]
            registry_sources = args.cargo_home / "registry" / "src"
            cached = [directory / f"{name}-{version}" / "Cargo.toml"
                      for directory in registry_sources.iterdir() if directory.is_dir()
                      and (directory / f"{name}-{version}" / "Cargo.toml").is_file()]
            if len(locks) != 1 or len(cached) != 1:
                raise ValueError(f"Ambiguous/missing selected package metadata: {name} {version} {suffix}")
            manifest_path = cached[0].resolve()
            parsed = tomllib.loads(manifest_path.read_text(encoding="utf-8"))
            declared = parsed["package"]
            if (declared["name"], declared["version"]) != (name, version):
                raise ValueError(f"Cached manifest identity mismatch: {manifest_path}")
            identity = f"cargo-lock:{name}@{version}|{locks[0].get('source', 'workspace')}"
            package = {"id": identity, "name": name, "version": version,
                       "source": locks[0].get("source"), "manifest_path": str(manifest_path),
                       "license": declared.get("license"), "license_file": declared.get("license-file"),
                       "targets": [{"kind": ["proc-macro"]}] if parsed.get("lib", {}).get("proc-macro") else [],
                       "inventoryMetadataOrigin": "selected Cargo.lock identity plus exact cached Cargo.toml",
                       "lockfileChecksum": locks[0].get("checksum")}
            packages[identity] = package
            fallback_ids.add(identity)
        else:
            package = candidates[0]
        label_cache[label] = package
        return package

    line_pattern = re.compile(r"^(\d+)(\S+) v(\S+)(.*)$")
    runtime_ids, macro_ids, normal_ids, all_ids = set(), set(), set(), set()
    ancestors, normal_edges = [], set()
    for line in normal_path.read_text(encoding="utf-8-sig").splitlines():
        match = line_pattern.match(line)
        if not match:
            continue
        depth, name, version, suffix = match.groups()
        depth = int(depth)
        package = resolve_package(name, version, suffix)
        if depth > len(ancestors):
            raise ValueError(f"Unexpected tree depth: {line}")
        ancestors[depth:] = []
        is_macro = any("proc-macro" in t["kind"] for t in package["targets"])
        through_macro = is_macro or bool(ancestors and ancestors[-1][1])
        identity = package["id"]
        normal_ids.add(identity)
        (macro_ids if through_macro else runtime_ids).add(identity)
        if ancestors:
            normal_edges.add((ancestors[-1][0], identity, through_macro))
        ancestors.append((identity, through_macro))
    for line in build_path.read_text(encoding="utf-8-sig").splitlines():
        match = line_pattern.match(line)
        if match:
            _, name, version, suffix = match.groups()
            all_ids.add(resolve_package(name, version, suffix)["id"])
    if not normal_ids <= all_ids:
        raise ValueError("The normal+build tree omits packages in the normal tree")
    nodes = {node["id"]: node for node in metadata["resolve"]["nodes"]}
    copied = {}

    def preserve(source: Path, package: dict, name: str | None = None) -> dict:
        destination = license_root / f"{package['name']}-{package['version']}" / (name or source.name)
        if not destination.resolve().is_relative_to(license_root.resolve()):
            raise ValueError(f"Unsafe candidate path: {destination}")
        destination.parent.mkdir(parents=True, exist_ok=True)
        digest = sha256(source)
        if destination.exists():
            if sha256(destination) != digest:
                raise ValueError(f"Refusing to overwrite different candidate license: {destination}")
        else:
            shutil.copyfile(source, destination)
        if sha256(destination) != digest:
            raise ValueError(f"License copy mismatch: {destination}")
        record = {"source": file_evidence(source), "candidateCopy": file_evidence(destination)}
        copied[str(destination)] = record
        return record["candidateCopy"]

    inventory = []
    for identity in sorted(all_ids):
        package = packages[identity]
        manifest = Path(package["manifest_path"]).resolve(strict=True)
        directory = manifest.parent
        workspace_source = directory.is_relative_to(engines)
        observed = {p.resolve() for p in directory.iterdir() if p.is_file()
                    and re.match(r"^(LICENSE|LICENCE|COPYING|NOTICE)", p.name, re.I)}
        declared_file = package.get("license_file")
        resolved_file, declared_exists = None, None
        if declared_file:
            resolved_file = (directory / declared_file).resolve()
            declared_exists = resolved_file.is_file()
            if declared_exists:
                observed.add(resolved_file)
            else:
                unresolved.append({"package": identity, "fact": "declared license_file is absent", "path": str(resolved_file)})
        if not package.get("license") and not declared_file and not workspace_source:
            unresolved.append({"package": identity, "fact": "no declared license expression or license_file"})
        if not observed and not workspace_source:
            unresolved.append({"package": identity, "fact": "no adjacent license/copying/notice file observed"})
        roles = []
        if identity in runtime_ids:
            roles.append("runtime-source-candidate")
        if identity in macro_ids:
            roles.append("proc-macro-host-input")
        if identity not in normal_ids:
            roles.append("build-dependency-input")
        licenses = []
        for path in sorted(observed):
            record = file_evidence(path)
            record["candidateCopy"] = preserve(path, package) if identity in runtime_ids else None
            licenses.append(record)
        repo_evidence = None
        if workspace_source:
            root_license = engines / "LICENSE"
            repo_evidence = file_evidence(root_license)
            repo_evidence["expressionObservedInText"] = "Apache-2.0"
            repo_evidence["candidateCopy"] = preserve(root_license, package, "REPOSITORY-LICENSE") if identity in runtime_ids else None
        inventory.append({"id": identity, "name": package["name"], "version": package["version"],
                          "source": package.get("source"), "manifestPath": str(manifest), "manifestSha256": sha256(manifest),
                          "metadataOrigin": package.get("inventoryMetadataOrigin", "Cargo metadata"),
                          "lockfileChecksum": package.get("lockfileChecksum"), "roles": roles,
                          "activeFeaturesInWorkspaceMetadata": sorted(nodes.get(identity, {}).get("features", [])),
                          "declaredLicenseExpression": package.get("license"), "declaredLicenseFile": declared_file,
                          "resolvedDeclaredLicenseFile": str(resolved_file) if resolved_file else None,
                          "declaredLicenseFileExists": declared_exists, "observedLicenseNoticeFiles": licenses,
                          "workspaceRepositoryLicenseEvidence": repo_evidence})
    artifact_paths = ([args.wasm_artifact] if args.wasm_artifact else []) + args.additional_wasm_artifact
    artifacts = []
    for path in artifact_paths:
        resolved_artifact = path.resolve(strict=True)
        if not resolved_artifact.is_relative_to((candidate_root / "firebird").resolve()):
            raise ValueError(f"Artifact is outside the Firebird-only candidate module: {resolved_artifact}")
        artifacts.append(file_evidence(resolved_artifact))
    artifact = artifacts[0] if artifacts else None
    selected = {"rootPackage": "query-compiler-wasm", "target": "wasm32-unknown-unknown",
                "noDefaultFeatures": True, "requestedFeatures": ["firebird"], "locked": True, "offline": True}
    artifact_license_manifest = license_root / "manifest.json"
    artifact_license_manifest.parent.mkdir(parents=True, exist_ok=True)
    artifact_record = {"schemaVersion": 1, "scope": "Firebird-only query-compiler Wasm selection; other provider assets are not audited by this manifest",
                       "selection": selected, "wasmArtifact": artifact, "wasmArtifacts": artifacts,
                       "runtimePackageIds": sorted(runtime_ids),
                       "runtimePackages": [{key: package[key] for key in (
                           "id", "name", "version", "source", "metadataOrigin", "declaredLicenseExpression",
                           "declaredLicenseFile", "observedLicenseNoticeFiles", "workspaceRepositoryLicenseEvidence")}
                           for package in inventory if package["id"] in runtime_ids],
                       "copiedLicenseFiles": list(copied.values()),
                       "unresolvedRuntimeFacts": [p for p in unresolved if p["package"] in runtime_ids],
                       "limitation": "Conservative reachable source inventory; no legal conclusion or byte-level linked-code attribution"}
    artifact_license_manifest.write_text(json.dumps(artifact_record, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    result = {"schemaVersion": 1, "recordedAtUtc": datetime.now(timezone.utc).isoformat(),
              "purpose": "Factual selected-root dependency and observed license-file inventory; no legal conclusion",
              "enginesBaseline": "d1b3f377ca835d73fd50954a5e22128b9ebdd6b8",
              "toolchain": "1.97.1-x86_64-pc-windows-msvc", "selection": selected,
              "lockfile": file_evidence(engines / "Cargo.lock"), "wasmArtifact": artifact, "wasmArtifacts": artifacts,
              "candidateArtifactLicenseManifest": file_evidence(artifact_license_manifest),
              "resolverCommands": [
                  "cargo tree --locked --offline -p query-compiler-wasm --no-default-features --features firebird --target wasm32-unknown-unknown --edges normal --prefix depth --no-dedupe --format {p}",
                  "cargo tree --locked --offline -p query-compiler-wasm --no-default-features --features firebird --target wasm32-unknown-unknown --edges normal,build --prefix depth --no-dedupe --format {p}",
                  "cargo metadata --locked --offline --format-version 1 --filter-platform wasm32-unknown-unknown --no-default-features --features query-compiler-wasm/firebird"],
              "rawResolverEvidence": [file_evidence(p) for p in (metadata_path, normal_path, build_path)],
              "counts": {"runtimeSourceCandidates": len(runtime_ids), "procMacroHostInputs": len(macro_ids),
                         "buildDependencyOnlyInputs": len(all_ids - normal_ids), "uniqueSelectedPackages": len(all_ids),
                         "broaderWorkspaceMetadataPackages": len(metadata["packages"]), "selectedCachedManifestFallbacks": len(fallback_ids),
                         "copiedRuntimeLicenseFiles": len(copied), "unresolvedFacts": len(unresolved)},
              "runtimePackageIds": sorted(runtime_ids), "procMacroHostInputIds": sorted(macro_ids),
              "buildDependencyOnlyInputIds": sorted(all_ids - normal_ids),
              "normalDependencyEdges": [{"from": a, "to": b, "throughProcMacro": c} for a, b, c in sorted(normal_edges)],
              "packages": inventory, "unresolvedFacts": unresolved,
              "limitations": [
                  "Package membership and ancestry come from the exact selected-root target-filtered trees, not all workspace metadata packages or Cargo.lock entries.",
                  "Target-filtered workspace metadata can omit host-only packages; missing selected identities use only the exact locked crate's cached Cargo.toml and are labeled explicitly.",
                  "Proc-macro paths and build-only packages are classified separately; packages may have runtime and host roles. Only runtime-candidate license files are copied.",
                  "Workspace metadata feature sets can be broader than the selected tree and are labeled accordingly.",
                  "This conservative source graph does not establish which code survives linking or legal sufficiency; SPDX alternatives are recorded without choosing or interpreting them.",
                  "Only selected package directories and declared license_file paths are read; no full recursive cache scan is performed.",
                  "Workspace repository license observations do not fill missing crate-level declared license expressions.",
                  "Other preserved upstream provider assets are outside this Firebird-only inventory. Regenerate after final source marking/rebuild; a null Wasm artifact means its final hash is pending."]}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    print(json.dumps({"path": str(output), "counts": result["counts"], "sha256": sha256(output)}, indent=2))


if __name__ == "__main__":
    main()

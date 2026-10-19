# Added in this experimental Firebird fork; see MODIFICATIONS.md.
"""Capture offline, locked Cargo resolver evidence without building or fetching."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess


def file_evidence(path: Path) -> dict:
    return {"path": str(path), "bytes": path.stat().st_size,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--engines-root", type=Path, required=True)
    parser.add_argument("--root-package", required=True)
    parser.add_argument("--features", default="")
    parser.add_argument("--use-default-features", action="store_true")
    parser.add_argument("--output-directory", type=Path, required=True)
    parser.add_argument("--cargo", default="cargo")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-zA-Z0-9_-]+", args.root_package):
        parser.error("Invalid root package")
    features = args.features.split(",") if args.features else []
    if any(not re.fullmatch(r"[a-zA-Z0-9_-]+", feature) for feature in features):
        parser.error("Features must be comma-separated package feature names")
    engines = args.engines_root.resolve(strict=True)
    lockfile_before = file_evidence(engines / "Cargo.lock")
    workspace_manifest_before = file_evidence(engines / "Cargo.toml")
    output = args.output_directory.resolve()
    output.mkdir(parents=True, exist_ok=True)
    feature_arguments = ([] if args.use_default_features else ["--no-default-features"])
    if features:
        feature_arguments += ["--features", args.features]
    metadata_feature_arguments = ([] if args.use_default_features else ["--no-default-features"])
    if features:
        metadata_feature_arguments += ["--features", ",".join(f"{args.root_package}/{feature}" for feature in features)]
    tree = [args.cargo, "tree", "--locked", "--offline", "-p", args.root_package,
            *feature_arguments, "--target", "wasm32-unknown-unknown"]
    commands = [
        ("wasm-runtime-tree", tree + ["--edges", "normal", "--prefix", "depth", "--no-dedupe", "--format", "{p}"]),
        ("wasm-build-input-tree", tree + ["--edges", "normal,build", "--prefix", "depth", "--no-dedupe", "--format", "{p}"]),
        ("wasm-runtime-metadata", [args.cargo, "metadata", "--locked", "--offline", "--format-version", "1",
                                   "--filter-platform", "wasm32-unknown-unknown", *metadata_feature_arguments]),
    ]
    receipt = {"recordedAtUtc": datetime.now(timezone.utc).isoformat(), "rootPackage": args.root_package,
               "noDefaultFeatures": not args.use_default_features,
               "requestedFeatures": features, "target": "wasm32-unknown-unknown", "enginesRoot": str(engines),
               "toolchainEnvironment": os.environ.get("RUSTUP_TOOLCHAIN"),
               "lockfileBefore": lockfile_before, "workspaceManifestBefore": workspace_manifest_before,
               "method": "Read-only Cargo tree and metadata commands, all locked and offline; no build, test or fetch", "commands": []}
    child_environment = dict(os.environ)
    child_environment["CARGO_TERM_COLOR"] = "never"
    receipt["formattingEnvironment"] = {"CARGO_TERM_COLOR": "never"}
    for stem, command in commands:
        destination = output / (stem + (".json" if stem.endswith("metadata") else ".txt"))
        stderr = output / f"{stem}.stderr.txt"
        if destination.exists() or stderr.exists():
            raise FileExistsError(f"Resolver evidence already exists; choose a new snapshot directory: {destination}")
        with destination.open("wb") as stdout_file, stderr.open("wb") as stderr_file:
            process = subprocess.run(command, cwd=engines, stdout=stdout_file, stderr=stderr_file,
                                     env=child_environment, check=False)
        receipt["commands"].append({"arguments": command, "exitCode": process.returncode,
                                    "stdout": {"path": str(destination), "bytes": destination.stat().st_size,
                                               "sha256": hashlib.sha256(destination.read_bytes()).hexdigest()},
                                    "stderr": {"path": str(stderr), "bytes": stderr.stat().st_size,
                                               "sha256": hashlib.sha256(stderr.read_bytes()).hexdigest()}})
        receipt["lockfileAfter"] = file_evidence(engines / "Cargo.lock")
        receipt["workspaceManifestAfter"] = file_evidence(engines / "Cargo.toml")
        (output / "resolver-commands.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
        print(f"{stem}: exit {process.returncode}, {destination.stat().st_size} bytes", flush=True)
        if process.returncode:
            raise RuntimeError(f"Resolver command failed; inspect {stderr}")
        if receipt["lockfileAfter"] != lockfile_before or receipt["workspaceManifestAfter"] != workspace_manifest_before:
            raise RuntimeError("Cargo.lock or the workspace Cargo.toml changed during resolver capture; use a fresh snapshot")


if __name__ == "__main__":
    main()

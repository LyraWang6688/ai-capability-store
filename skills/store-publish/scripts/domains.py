#!/usr/bin/env python3
"""Which top-level mapping holds each peer Domain's entries.

Two scripts need this answer — `reuse_scan.py` ("does this asset already exist?")
and `check_tag_version.py` ("does this version's tag agree with the registry?") —
and they need it to be the *same* answer. When it lived as a hardcoded tuple in
each script, adding the `automations` Domain in October 2026 updated neither:
`reuse_scan` reported a registered automation as NEW (a false negative — it
invites a duplicate registration) and `check_tag_version` reported it as
unregistered (a false failure — it blocks a correct tag).

Each registry is its own document, so the entry mapping cannot be guessed from
the domain name alone:

    skills/registry.yaml                 -> skills:
    external-capabilities/registry.yaml  -> capabilities:
    automations/registry.yaml            -> automations:

A domain routed in `registry.yaml` but absent here is a **hard error**, not a
skip. A tool that confidently reports on a domain it never read is worse than a
tool that refuses to run.
"""

DOMAIN_ENTRY_KEYS = {
    "skills": "skills",
    "external_capabilities": "capabilities",
    "automations": "automations",
    # 编排是一个【资产】域：每个编排各有 identity / path / version，
    # 只是它没有实现代码，所以没有 package.json，--package 会跳过它。
    # 但 --missing 要管它 —— 登记了版本就必须有 tag。
    "orchestrations": "orchestrations",
}

# Routed in registry.yaml, but holds relationships between assets rather than
# defining assets of its own.
NON_ASSET_REGISTRIES = {"dependencies"}


def unknown_domains(routes):
    """Routed domains this module does not know how to read, sorted."""
    return sorted(set(routes) - set(DOMAIN_ENTRY_KEYS) - NON_ASSET_REGISTRIES)


def asset_sections(routes, load_registry, fail):
    """Yield (domain, registry_path, entries) for every peer Domain defining assets.

    `routes`        the router's `registries:` mapping (domain -> relative path)
    `load_registry` callable(relative_path) -> parsed document or None
    `fail`          callable(message) -> NoReturn, used for the unknown-domain case
    """
    missing = unknown_domains(routes)
    if missing:
        fail(
            "registry.yaml routes a domain this tool does not know: "
            + ", ".join(missing)
            + ".\nAdd it to DOMAIN_ENTRY_KEYS in domains.py (domain -> the "
            "top-level map holding its entries). Both reuse_scan and "
            "check_tag_version read through this module; a domain one of them "
            "skips is a domain it will answer about wrongly."
        )
    for domain, key in DOMAIN_ENTRY_KEYS.items():
        rel = routes.get(domain)
        if not rel:
            continue
        data = load_registry(rel) or {}
        entries = data.get(key)
        if isinstance(entries, dict):
            yield domain, rel, entries

# Agent guidance

Use [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks, and isolated local runs. This file records maintainer decisions, not a second project manual.

## Where to look

- Product scope and platform support: [README.md](README.md).
- Setup, local runs, and checks: [CONTRIBUTING.md](CONTRIBUTING.md).
- CLI commands and output: [docs/cli.md](docs/cli.md).
- YAML config and dependency rules: [docs/config.md](docs/config.md).
- Process ownership, dashboard, logs, startup, and local access: [docs/operations.md](docs/operations.md).
- Packaging and release procedure: [docs/releasing.md](docs/releasing.md), [scripts/](scripts/), and [.github/workflows/](.github/workflows/).
- Earlier design reasoning and recorded checks: [docs/plans/](docs/plans/) and [docs/acceptance.md](docs/acceptance.md).

Plans and acceptance records describe earlier work. They are not a new task list or proof that the current checkout passes. Use current instructions and reference docs when they conflict with older plans.

## Design decisions

- Keep normal use simple. Do not add lifecycle rules, fallback paths, or extra infrastructure for hypothetical failures. Fix observed failures at their cause; do not hide them with blanket exception handling.
- Dashboard login, single-use links, expiry, and session cookies were removed on purpose. Do not restore them without a new requirement. Keep the existing loopback and Host/Origin protections.
- Prefer suitable open-source libraries over custom implementations of standard CLI and UI behavior. Custom HTML support is an escape hatch, not a reason to build a customization framework or promise a stable extension API.

## UI decisions

- The main workflow is monitoring several projects, usually one project at a time. Favor clear project groups and easy scanning over more controls and information on screen.
- Use official shadcn examples for filters, menus, and table controls. Design references are inspiration, not requirements to copy unchanged.
- Avoid duplicate counts and single-action overflow menus. Keep routine actions easy to find, tab boundaries clear, and icon sizes consistent. More features do not justify a busier interface.

## Dependency changes

- Check upstream and use the latest stable release when adding or updating a dependency or tool. Use readable release tags or version ranges, not commit-hash or image-digest version pins.
- Keep lockfiles, integrity hashes, archive checksums, and commit IDs that identify release source. These are not version pins to remove.

## Documentation and release

- Write user docs for the current product, not the preparation process. Avoid future-work disclaimers, and internal review notes.
- Keep the main product description platform-neutral. State current platform support separately in the README.
- Release preparation is not permission to publish. Changing repository visibility, publishing a release, or publishing the Homebrew tap needs explicit approval.

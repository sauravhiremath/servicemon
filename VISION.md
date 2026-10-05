# Vision

**Make local development services easy to find, open, and control across projects—for humans and coding agents.**

## Why Servicemon exists

Starting a service is easy. Keeping track of services across several projects is harder: what is running, which URL to open, where the logs are, and which command to use.

Servicemon brings registered native services, tasks, and Docker Compose services into one project-based dashboard and CLI. The goal is less searching, less remembering, and fewer separate ways to manage the same services.

## What matters

- **See projects together.** Check service state, open configured links without remembering ports, read logs, and use clear controls.
- **Keep existing tools.** Use existing development commands, their reload behavior, and Compose files.
- **Share control with agents.** Humans and agents use the same registered commands, service IDs, status, and logs instead of managing separate copies.
- **Make addresses clear.** Reduce guessing about service URLs. Today, links are configured; Servicemon does not discover actual ports or guarantee that a server cannot select another port.
- **Keep it simple.** More projects should not require a busier interface. Setup must save more work than it creates.

## Where it fits

Servicemon is a local development tool, not a production or remote operations platform. It does not need to replace Docker Compose, Process Compose, or application reload tools. If an existing setup is easy to manage, there may be no reason to switch.

Its value must come from making daily work across projects easier—not from claiming unique process-management features.

## Success

Developers can return to a project, find and open the right services, check logs, and let an agent use the same manager without reconstructing the setup from terminals.

**Servicemon earns its place when the repeated work it removes is worth one more tool.**

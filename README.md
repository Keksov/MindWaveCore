# MindWaveCore

Assembled host core product.

Current ownership:

- `products/MindWaveCore/server`
- `products/MindWaveCore/ui`
- host-only composition logic that coordinates product modules

The legacy `pas/server` tree has been retired.

Host composition contract:

- Each Core UI product exposes a source-level package from its own `ui` directory; the public surface is declared in that module's `ui/package.json`.
- MindWaveCore imports only the declared `ui/module`, `ui/plugin`, and other documented subpaths instead of reaching into product-internal implementation files.
- Module descriptors contribute routes, settings tabs, and locale bundles; route contributions stay lazy by exposing `import()` loaders.
- MindWaveCore installs each module plugin with host-owned runtime services and merges module locale messages into the shared `vue-i18n` instance.
- Host-owned navigation keys remain under shell namespaces such as `nav.settings`, `nav.log`, and `nav.archive`; module-owned navigation keys stay under their own route namespaces such as `nav.monitoring` and `nav.audio`.

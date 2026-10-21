# lifeos-searxng (product brief: compose-only edition): SearXNG with LifeOS's settings and first-start
# secret script baked in, so the compose file needs no local files beside it.
FROM searxng/searxng:2026.10.19-81371861f
COPY settings.yml start.sh /lifeos/
ENTRYPOINT ["/bin/sh", "/lifeos/start.sh"]

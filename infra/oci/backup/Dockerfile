# One-shot backup/restore tool image for the MATCHDAY production stack.
# Base is the SAME digest-pinned Postgres image as compose.prod.yaml, so pg_dump/pg_restore
# always match the server's major version. Only bash, curl (SigV4 uploads) and age are added.
# The apk packages come from the Alpine release channel of the pinned base; rebuild with
# `docker compose --profile backup build --pull backup` after bumping the base digest.
FROM postgres:18.4-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15

RUN apk add --no-cache bash curl age

COPY lib.sh matchday-backup.sh restore-postgres.sh /opt/matchday-backup/
RUN chmod 0555 /opt/matchday-backup/*.sh

ENTRYPOINT ["/opt/matchday-backup/matchday-backup.sh"]
CMD ["backup"]

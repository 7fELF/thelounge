FROM node:12-alpine

ENV NODE_ENV production

ENV THELOUNGE_HOME "/var/opt/thelounge"
VOLUME "${THELOUNGE_HOME}"

# Expose HTTP.
ENV PORT 9000
EXPOSE ${PORT}

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["thelounge", "start"]

COPY docker-entrypoint.sh /usr/bin/docker-entrypoint.sh
WORKDIR /var/opt/src/theloungesrc
COPY . .

RUN yarn --non-interactive --frozen-lockfile && \
	yarn build && \
	yarn link && \
	yarn --non-interactive cache clean

IMAGE_NAME = olleb.com

.PHONY: all install dev build stop clean help

all: dev

install:
	podman run --rm -v .:/app:z -w /app node:20-alpine npm install

dev:
	podman compose up --force-recreate

build:
	podman build -t $(IMAGE_NAME) -f Containerfile .

stop:
	podman compose down

clean:
	podman compose down -v
	podman container prune -f
	rm -rf node_modules
	@podman images -f "dangling=true" -q | xargs -r podman rmi -f 2>/dev/null || true
	@podman rmi $(IMAGE_NAME) 2>/dev/null || true

help:
	@fgrep -h "##" $(MAKEFILE_LIST) | fgrep -v fgrep | sed -e 's/\\$$//' | sed -e 's/##//'

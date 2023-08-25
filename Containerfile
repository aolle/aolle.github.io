FROM docker.io/jekyll/jekyll

RUN apk add --no-cache --virtual .build-deps \
        libxml2-dev \
        shadow \
        autoconf \
        g++ \
        make

WORKDIR /srv/jekyll

ADD . /srv/jekyll/

RUN bundle install

EXPOSE 8080

CMD bundler exec jekyll serve --watch --port=8080 --host=0.0.0.0 --livereload --verbose --trace

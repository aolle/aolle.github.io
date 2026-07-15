FROM node:22-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install

EXPOSE 4321

CMD ["node", "./node_modules/.bin/astro", "dev", "--host", "0.0.0.0", "--port", "4321", "--force"]

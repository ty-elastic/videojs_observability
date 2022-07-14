FROM node:current-alpine

WORKDIR /home/player

COPY package.json .
COPY package-lock.json .
COPY webpack.dev.config.js .
COPY webpack.prod.config.js .

RUN npm install

CMD ["npm", "run", "start"]
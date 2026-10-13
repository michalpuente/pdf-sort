FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html/pdf-sort
COPY nginx.conf /etc/nginx/conf.d/default.conf
# .mjs worker must be served as JavaScript, otherwise pdf.js refuses to load it
RUN sed -i 's|application/javascript\s*js;|application/javascript js mjs;|' /etc/nginx/mime.types
EXPOSE 80

FROM node:20-bookworm-slim

# Install GDAL (ogr2ogr) for generating SHP, GPKG, GDB at startup
RUN apt-get update && \
    apt-get install -y --no-install-recommends gdal-bin && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .

# Generate all static test data files
RUN node generate-data.js

# HTTP + HTTPS
EXPOSE 3333 3443
CMD ["node", "server.js"]

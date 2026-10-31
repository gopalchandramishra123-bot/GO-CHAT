# Google Cloud Run Dockerfile for GO-CHAT Signalling Backend
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install production dependencies only
COPY package*.json ./
RUN npm install --omit=dev --legacy-peer-deps

# Copy application files
COPY signalling-server.js ./

# Set environment
ENV NODE_ENV=production
ENV PORT=8080

# Cloud Run injects PORT and listens on 0.0.0.0
EXPOSE 8080

# Run signalling server
CMD ["node", "signalling-server.js"]

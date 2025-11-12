# Dockerfile
# GHCR build enabled — optimized for production

FROM node:20-alpine AS base

# Set working directory
WORKDIR /app

# Install dependencies separately to leverage Docker layer caching
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Use a non-root user for security (optional but recommended)
RUN addgroup app && adduser -S -G app app
USER app

# Expose port (optional, if your app listens on a known port)
EXPOSE 3000

# Start the app
CMD ["npm", "start"]

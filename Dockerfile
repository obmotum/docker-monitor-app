# Use an official Node.js runtime as a parent image
FROM node:slim AS builder

# Set the working directory in the container
WORKDIR /app/backend

# Copy package.json and package-lock.json (if available)
COPY backend/package*.json ./

# Install app dependencies needed for backend runtime
# Using --omit=dev to skip devDependencies like nodemon in final image
RUN npm install --omit=dev

# Copy the rest of the backend application code
COPY backend/ ./

# --- Frontend Stage (simply copy files) ---
WORKDIR /app
COPY frontend/ ./frontend/


# --- Final image ---
FROM node:slim

WORKDIR /app

# Copy built backend from builder stage (including node_modules)
COPY --from=builder /app/backend ./backend

# Copy frontend files
COPY --from=builder /app/frontend ./frontend


# Make port 3000 available to the world outside this container
EXPOSE 3000

# Define environment variables (can be overridden at runtime)
ENV NODE_ENV=production
ENV PORT=3000
ENV FRONTEND_PATH=/app/frontend
# TARGET_CONTAINER_ID needs to be set at runtime

# Run server.js when the container launches
CMD ["node", "backend/server.js"]
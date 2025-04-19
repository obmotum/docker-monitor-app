# Docker Real-Time Monitor

A simple, modern-looking web application to monitor a *single* running Docker container's stats and logs in real-time using WebSockets. It also provides basic controls to restart or upgrade the monitored container.

## Features

*   **Real-time Stats:** Displays CPU Usage (%), Memory Usage / Limit (MB/GB), Memory Usage (%), Network I/O (Rx/Tx), and Disk I/O (Read/Write).
*   **Real-time Logs:** Streams the container's `stdout` and `stderr` to a dedicated console view.
*   **Container Info:** Shows the monitored container's Name, ID (short), Image, and current Status.
*   **Basic Controls:**
    *   **Restart:** Restarts the monitored container.
    *   **Upgrade:** Pulls the `latest` tag of the container's image and recreates the container with the same configuration (experimental, see limitations).
*   **WebSockets:** Uses WebSockets for efficient real-time communication between the backend and frontend.
*   **Simple UI:** Clean, tabbed interface for easy navigation between Stats, Logs, and Actions.
*   **Status Indicators:** Shows WebSocket connection status and provides status messages for actions.

## Tech Stack

*   **Backend:**
    *   Node.js
    *   Express (for serving static files)
    *   `ws` (for WebSocket server)
    *   `dockerode` (Node.js client for the Docker Engine API)
*   **Frontend:**
    *   HTML5
    *   CSS3
    *   Vanilla JavaScript (ES6+)
    *   Browser WebSocket API
*   **Runtime:** Docker / Docker Compose (for running the monitor app itself)

## Prerequisites

*   **Node.js:** Version 16.x or higher (for local development/running).
*   **npm** or **yarn:** Package manager for Node.js.
*   **Docker Engine:** Must be installed and running on the host where the backend service will execute.
*   **Docker Socket Access:** The backend process (or its container) needs read/write access to the Docker daemon socket (usually `/var/run/docker.sock`).
*   **A Running Target Container:** You need at least one Docker container running that you want to monitor.

## Setup and Installation

You can run this application either directly using Node.js or via Docker (recommended).

### Option 1: Running Locally (for development)

1.  **Clone the repository:**
    ```bash
    git clone <your-repo-url> docker-monitor-app
    cd docker-monitor-app
    ```
2.  **Install backend dependencies:**
    ```bash
    cd backend
    npm install
    cd ..
    ```
3.  **Set Environment Variable:** Specify the container to monitor.
    ```bash
    # Linux/macOS
    export TARGET_CONTAINER_ID="your_container_name_or_id"

    # Windows (Command Prompt)
    set TARGET_CONTAINER_ID="your_container_name_or_id"

    # Windows (PowerShell)
    $env:TARGET_CONTAINER_ID="your_container_name_or_id"
    ```
    Replace `your_container_name_or_id` with the actual name or ID.
4.  **Start the backend server:**
    ```bash
    cd backend
    npm start
    ```
5.  **Access the application:** Open your browser to `http://localhost:3000`.

### Option 2: Running with Docker (Recommended)

This repository includes a `Dockerfile` and `docker-compose.yml` to easily run the monitor application itself as a container.

1.  **Clone the repository:**
    ```bash
    git clone <your-repo-url> docker-monitor-app
    cd docker-monitor-app
    ```
2.  **Configure `docker-compose.yml`:**
    *   Open the `docker-compose.yml` file in the project root.
    *   In the `services.docker-monitor.environment` section, **change the value** of `TARGET_CONTAINER_ID` to the name or ID of the container you want to monitor.
    ```yaml
    services:
      docker-monitor:
        # ... other settings
        environment:
          # REQUIRED: Set the ID or name of the container you want to monitor
          - TARGET_CONTAINER_ID=your_container_name_or_id # <<< CHANGE THIS
          # - PORT=3000 # Optional: change port
        # ... other settings
    ```
3.  **Build and Run the Container:**
    ```bash
    docker-compose up --build -d
    ```
    *   Use `docker compose up --build -d` if you are using Docker Compose V2.
4.  **Access the application:** Open your browser to `http://<your-server-ip>:3000` (use `localhost` if running Docker locally).

## Configuration

The backend server can be configured using environment variables:

*   **`TARGET_CONTAINER_ID`** ( **Required** ): The name or unique ID of the Docker container to monitor and control.
*   **`PORT`** (Optional): The port on which the web server will listen. Defaults to `3000`.
*   **`LOG_TAIL_COUNT`** (Optional): The number of recent log lines to fetch initially when connecting. Defaults to `100`.
*   **`FRONTEND_PATH`** (Optional): Path to the frontend files (mainly for internal use/debugging). Defaults to `../frontend`.

When running via Docker Compose, set these under the `environment` key in the `docker-compose.yml` file.

## Usage

1.  Navigate to the application URL (e.g., `http://localhost:3000`).
2.  The application will attempt to connect to the backend via WebSocket. The status is shown at the top.
3.  Use the tabs to navigate:
    *   **Info & Stats:** Displays container details and live resource usage statistics.
    *   **Console Logs:** Shows a live stream of the container's `stdout` and `stderr`. Use the "Clear" button to empty the view.
    *   **Actions:** Contains buttons for restarting or upgrading the container, and displays status messages from the backend.
4.  Click the "Restart" or "Upgrade" buttons to perform actions. Confirm the action in the popup. Status updates will appear in the "Status Messages" log area.

## Security Considerations

⚠️ **IMPORTANT:** This application provides direct control over parts of your Docker environment.

1.  **Docker Socket Access:** The backend requires access to `/var/run/docker.sock`. Mounting this socket into a container (as done in the provided `docker-compose.yml`) grants that container **root-equivalent privileges** on the host system. Anyone who can access this web application can potentially trigger actions on the host via the monitored container.
2.  **No Authentication:** This basic version **does not include any authentication or authorization**. Anyone who can reach the web server port can view stats/logs and trigger restart/upgrade actions.
3.  **Exposure:** **DO NOT expose this application directly to the internet without putting a robust authentication and authorization layer in front of it.**
    *   **Recommendation:** Use a reverse proxy (like Nginx, Traefik, Caddy) configured with an authentication provider (like Authelia, OAuth2 Proxy, LDAP, or even simple HTTP Basic Auth) to protect access.

## Limitations & Future Enhancements

*   **Single Container Only:** Designed to monitor only one container specified at startup.
*   **Basic Upgrade:** The "Upgrade" function simply pulls the `:latest` tag of the image and recreates the container. It doesn't handle specific version tags, rollbacks, or complex configuration preservation beyond what `dockerode`'s `inspect` provides. Using Docker Compose for the *target* application is often more reliable for upgrades.
*   No historical stats or charting.
*   Limited error handling in the UI for complex Docker issues.

Potential future enhancements include:

*   Support for monitoring multiple containers (e.g., selection dropdown).
*   Built-in user authentication/authorization.
*   More sophisticated upgrade procedures.
*   Graphical charts for statistics over time.
*   Configuration persistence or UI-based configuration.
*   Integration with Docker Compose commands for actions.
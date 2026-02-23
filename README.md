# 📍 SmartNav-AI
### *Real-Time GPS Navigation & Routing in the Browser*

[![Live Demo](https://img.shields.io/badge/Demo-Live%20on%20Render-brightgreen?style=for-the-badge)](https://smartnav-ai.onrender.com)
[![GitHub](https://img.shields.io/badge/GitHub-Repo-blue?style=for-the-badge&logo=github)](https://github.com/Abhijit9999908/smartnav-ai)

**SmartNav-AI** is a lightweight, responsive web application that brings native-app GPS capabilities to the browser. By leveraging the Browser Geolocation API and Leaflet.js, it provides live movement tracking, route visualization, and real-time ETA calculations without the need for heavy installations.

---

## 🚀 Key Features

* **Live Geospatial Tracking:** Real-time location updates using the high-accuracy Browser Geolocation API.
* **Dynamic Route Mapping:** Interactive map visualization with auto-updating paths.
* **Navigation Dashboard:** Instant feedback on current coordinates, estimated distance, and ETA.
* **Cross-Platform Design:** Fully responsive UI optimized for both mobile "on-the-go" use and desktop browsing.
* **Privacy-Centric:** Request-based location access ensuring user data control.

---

## 🛠️ Tech Stack

| Layer | Technology |
| :--- | :--- |
| **Frontend** | JavaScript (ES6+), HTML5, CSS3 |
| **Backend** | Python (Flask) |
| **Mapping Engine** | Leaflet.js |
| **Geolocation** | Web Browser Geolocation API |
| **Deployment** | Render |

---

## 🧠 System Architecture

SmartNav-AI operates on a client-side heavy architecture to ensure low latency for location updates:

1. **Permission Layer:** The browser triggers a secure `navigator.geolocation` prompt.
2. **Data Acquisition:** Latitude and longitude are captured and passed to the Leaflet map instance.
3. **Backend Integration:** Flask handles potential route calculations and serves the application logic.
4. **UI Rendering:** CSS3 transitions provide smooth "marker sliding" as the user moves in the real world.

---

## ⚡ Quick Start

### Prerequisites
* Python 3.x
* A modern browser (Chrome, Firefox, or Safari) with Location Services enabled.

### Installation

1. **Clone the Repository**
   ```bash
   git clone [https://github.com/Abhijit9999908/smartnav-ai.git](https://github.com/Abhijit9999908/smartnav-ai.git)

   Navigate to Project Folder

### 2. Navigate to Project Folder
```bash
cd smartnav-ai
Install Dependencies

Bash
pip install -r requirements.txt
Run the Application

Bash
python app.py
📈 Future Roadmap
[ ] Voice-Guided Navigation: Integration with Web Speech API for hands-free directions.

[ ] AI Route Optimization: Using machine learning to suggest routes based on historical traffic data.

[ ] Offline Mode: Service Worker integration for map caching in low-signal areas.

[ ] Multi-Stop Routing: Ability to add waypoints between start and destination.

🎯 Why This Project Matters
This project serves as a practical implementation of asynchronous JavaScript and RESTful API design. It demonstrates how to handle real-world sensor data (GPS) and translate it into a meaningful user interface—a core skill for modern full-stack developers.

Developed by [Abhijit] Contributions and feedback are welcome! Feel free to open an issue or submit a pull request.

# 📍 SmartNav-AI
### *Real-Time GPS Navigation & Routing in the Browser*

[![Live Demo](https://img.shields.io/badge/Demo-Live%20on%20Render-brightgreen?style=for-the-badge)](https://smartnav-ai.onrender.com)
[![GitHub](https://img.shields.io/badge/GitHub-Repo-blue?style=for-the-badge&logo=github)](https://github.com/Abhijit9999908/smartnav-ai)
[![Download APK](https://img.shields.io/badge/Download-SmartNav.apk-orange?style=for-the-badge&logo=android)](https://github.com/Abhijit9999908/smartnav-ai/releases/latest/download/SmartNav.apk)

> 📱 **Android App** — Download the APK above, enable *Install unknown apps* in your phone settings, then tap the file to install.

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

### ⚙️ Installation

```bash
# 1. Clone the repo
git clone https://github.com/Abhijit9999908/smartnav-ai.git

# 2. Change directory
cd smartnav-ai

# 3. Install dependencies
pip install -r requirements.txt

# 4. Start the app
python app.py

```

🌐 Accessing the App
Once the server is running, open your browser and go to:
http://localhost:5000

⚠️ Important: You must click "Allow" when the browser asks for location permissions.

📈 Future Roadmap
[ ] 🎤 Voice-Guided Navigation: Integration with Web Speech API for hands-free directions.

[ ] 🤖 AI Route Optimization: Use machine learning to suggest smarter routes based on traffic patterns.

[ ] 📶 Offline Mode: Service Worker integration for map caching in low-signal areas.

[ ] 📍 Multi-Stop Routing: Add waypoints between start and destination.

🎯 Why This Project Matters
SmartNav-AI is a practical implementation of:

- Asynchronous JavaScript

- RESTful API architecture

- Real-time GPS data handling

- Interactive mapping systems

It demonstrates how real-world sensor data (GPS coordinates) can be processed and translated into a meaningful, responsive user interface—a core skill for modern full-stack developers.

👨‍💻 Author
-- Developed by Abhijit Rathod

> Install on Android: enable "Install unknown apps" in Settings, then open the downloaded APK.

Contributions and feedback are welcome! Feel free to open an issue or submit a pull request.

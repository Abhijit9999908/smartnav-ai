📍 SmartNav-AI — GPS Navigation Web App

SmartNav-AI is a responsive web application that provides live GPS-based navigation and routing directly in the browser. The site uses real-time location data to show your movement on an interactive map and guide you along routes — just like a simplified version of Google Maps’ navigation feature 🚗.

🔗 Live Demo: https://smartnav-ai.onrender.com

🌐 GitHub Repo: https://github.com/Abhijit9999908/smartnav-ai

📌 Demo Preview

Once location access is granted in your browser, SmartNav-AI detects your current position and shows:

✔ Current GPS coordinates
✔ Interactive live map route visualization
✔ Estimated distance & ETA
✔ Location tracking in real-time

🧠 Features
Feature	Description
🚀 Live Navigation	Tracks your current location using the browser’s GPS API
📍 Real-Time Map	Displays routes and movement on an interactive map
🗺️ Route Planning	Shows optimal route based on your location
📡 Geolocation Prompt	Requests permission and uses live GPS data to function
📱 Responsive UI	Works smoothly on mobile and desktop
🛠️ Built With

Python (Flask) — Backend REST API

JavaScript — Frontend logic & map integration

Leaflet / Browser Geolocation API — For GPS tracking and interactive map

HTML & CSS — UI design

Render (Cloud) — Deployment platform

📊 Languages breakdown (from GitHub):
JS ~36% · Python ~30% · CSS ~25% · HTML ~8%

💡 How It Works

User grants location access
When you visit the app, the browser asks for permission to use your GPS.

Live position tracking
SmartNav-AI reads your coordinates and displays your current location on the map.

Navigation UI
The interface shows navigation controls and real-time position changes as you move.

🧾 Installation (Run Locally)

If you want to run this project on your machine:

# 1. Clone the repo
git clone https://github.com/Abhijit9999908/smartnav-ai.git

# 2. Change directory
cd smartnav-ai

# 3. Install dependencies
pip install -r requirements.txt

# 4. Start the app
python app.py

# 5. Open in browser
# goto http://localhost:5000

⚠️ Make sure you allow location permissions when prompted in the browser.

🖼 Screenshots

💡 After enabling location:

![Map with Navigation Controls](https://user-images.githubusercontent.com/
 ... )

🚀 Live ETA & GPS speed tracking:

![Live route, ETA display](https://user-images.githubusercontent.com/
 ... )

(You can replace these example screenshots with your own from the deployed site.)

📈 Future Enhancements

Here are potential additions you can include next:

✔ Turn-by-turn voice navigation
✔ Offline maps support
✔ Save favorite locations
✔ Routing suggestions
✔ AI-based route optimization

🎯 Why This Project Matters

SmartNav-AI demonstrates practical GPS integration with web technologies — a real-time, location-based application that works without heavy native apps or complex installation. It’s useful for learning:

Geolocation APIs

Map integration

Flask + JS communication

Deployment workflows

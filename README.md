# Sports Media Integrity Grid Security Engine

A web application designed to detect copyright infringement for sports media assets using a combination of perceptual hashing (pHash) and AI-powered visual analysis (Google Gemini).

## Features

- **Register Original Assets**: Upload original media assets. Crop and resize the images before registration to focus on key identifying areas. The system generates a perceptual hash (pHash) and a simulated blockchain transaction hash for immutable tracking.
- **AI-Powered Detection**: Submit a suspect image or screenshot found online. The system uses a local pHash comparison for a quick similarity pre-check, followed by an advanced analysis using Google's Gemini Pro Vision model to detect modifications, crops, color filters, and text overlays/watermarks.
- **Detection Dashboard**: View a comprehensive log of all recent checks. Filter the logs by risk status (High-Risk, Low-Risk, Safe) and sort by time, confidence score, or platform.
- **Takedown Notice Generation**: Automatically generate DMCA takedown notices for High-Risk assets with a single click, ready to be copied to your clipboard.
- **Asset Search**: Quickly search through your registered official assets using filename or watermark ID.
- **Asynchronous Processing**: Analysis tasks are handled asynchronously so you can continue using the dashboard while the AI processes suspect images in the background.

## Technology Stack

- **Frontend**: React 18, Vite, Tailwind CSS, Lucide React (Icons)
- **Image Processing**: `react-image-crop` for client-side editing, custom canvas-based pHash implementation.
- **AI Analysis**: Google GenAI SDK (`@google/genai`), using the `gemini-2.5-pro` model.

## Getting Started

1. Set up your Gemini API Key. Ensure that `GEMINI_API_KEY` is present in your environment variables.
2. Run the development server using `npm run dev`.
3. Open the application in your browser. Register some official assets, then use the Detection interface to scan suspect images against your registry.

## Note on Authentication

Firebase Authentication has been integrated. You can sign up and log in with your email and password. Please ensure that the **Email/Password** authentication provider is enabled in your Firebase Console.

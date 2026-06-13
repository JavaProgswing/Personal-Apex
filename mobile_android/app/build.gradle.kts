plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.yashasvi.apex.mobile"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.yashasvi.apex.mobile"
        minSdk = 26
        targetSdk = 35
        versionCode = 9
        versionName = "0.6.3"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    // Background, battery-friendly periodic usage sync (no app open / no USB).
    implementation("androidx.work:work-runtime-ktx:2.9.1")
    // ComponentActivity → registerForActivityResult (used by the QR scanner).
    implementation("androidx.activity:activity-ktx:1.9.3")
    // Pull-to-refresh on every tab.
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.1.0")
    // QR scanning for one-tap pairing (scan the code shown on desktop).
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
}

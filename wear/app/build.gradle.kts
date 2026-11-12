import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "dev.maxbuda.handoff"
    compileSdk = 37

    defaultConfig {
        applicationId = "dev.maxbuda.handoff"
        minSdk = 33 // Wear OS 4 and newer (Pixel Watch 4 and 5 run Wear OS 6)
        targetSdk = 36
        versionCode = 2
        versionName = "1.3"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    // The Play upload key lives outside the repo, in ~/.handoff-keys (see docs/play-store). Without it,
    // release builds are signed with the debug key, which is fine for installing over adb but not for Play.
    val keys = File(System.getProperty("user.home"), ".handoff-keys/keystore.properties")
    signingConfigs {
        if (keys.exists()) create("upload") {
            val p = Properties()
            keys.inputStream().use { p.load(it) }
            storeFile = File(p.getProperty("storeFile"))
            storePassword = p.getProperty("storePassword")
            keyAlias = p.getProperty("keyAlias")
            keyPassword = p.getProperty("keyPassword")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
            signingConfig = signingConfigs.findByName("upload") ?: signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2026.09.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material:material-icons-extended:1.7.8")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.11.0")
    implementation("androidx.wear.compose:compose-material3:1.7.1")
    implementation("androidx.wear.compose:compose-foundation:1.7.1")
    implementation("androidx.wear.compose:compose-navigation:1.7.1")
    implementation("androidx.wear:wear-input:1.2.0")
    implementation("androidx.wear.tiles:tiles:1.6.2")
    implementation("androidx.wear.protolayout:protolayout:1.4.2")
    implementation("androidx.wear.protolayout:protolayout-material3:1.4.2")
    implementation("androidx.wear.watchface:watchface-complications-data-source-ktx:1.3.0")
    implementation("androidx.work:work-runtime-ktx:2.12.0")
    implementation("com.squareup.okhttp3:okhttp:5.5.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-guava:1.11.0")
}

dependencies {
    testImplementation("junit:junit:4.13.2")
}

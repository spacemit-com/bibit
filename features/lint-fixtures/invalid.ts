import store from '@/stores/session'
import serviceHub from '@/hooks/useServiceHub'
import services from '@/services'
import app from '../../web-app/src/main'
import { invoke } from '@tauri-apps/api/core'
import otherFeature from '../../other-feature/src'
import otherFeaturePackage from '@bibit/feature-memory/bibit-feature'
import axios from 'axios'

void store
void serviceHub
void services
void app
void invoke
void otherFeature
void otherFeaturePackage
void axios
void fetch('/secret')
void new WebSocket('ws://example.invalid')
void new EventSource('/events')
void window.core

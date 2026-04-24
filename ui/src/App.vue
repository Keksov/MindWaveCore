<template>
  <router-view />
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { wsService } from 'src/services/ws'

onMounted(() => {
  wsService.init()
})
</script>
